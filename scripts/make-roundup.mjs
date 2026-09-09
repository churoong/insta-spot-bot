// 모음집(공개형 N선) 자동 생성·발행 — GitHub Actions에서 실행.
// 흐름: 계절 가중 테마 선택 → TourAPI 수집(공공누리 확인) → 백년가게 대조 →
//       Gemini 한줄평·음식사진 선별 → v2 인포그래픽 표지 + 이름표 슬라이드 합성 →
//       업로드 → 캐러셀 발행 → Turso 기록.
//
// 필요한 환경변수: TOUR_API_KEY, GEMINI_API_KEY, GEMINI_MODEL,
//   TURSO_DATABASE_URL, TURSO_AUTH_TOKEN, IG_USER_ID, IG_ACCESS_TOKEN
//   (선택) BLOB_READ_WRITE_TOKEN, IG_USERNAME, ROUNDUP_DRY=1(발행 없이 미리보기 파일 생성)

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "roundup-"));
const TOUR = "https://apis.data.go.kr/B551011/KorService2";
const DRY = process.env.ROUNDUP_DRY === "1";
const HANDLE = process.env.IG_USERNAME || "tourist_710";
// 발행 '전에' 선기록한 posts 행. 발행 중 예외로 죽으면 마지막 catch가 이 행을 'failed'로
// 바꾼다 — 안 그러면 'publishing'이 영원히 남아 대시보드엔 "게시된 것처럼" 보이고
// 하루 1회 가드가 "오늘 이미 발행"으로 재발행까지 막는다 (2026-09-03 성수 편 실측).
let pending = null; // { db, cid }
const OFFLINE = process.env.ROUNDUP_OFFLINE === "1";
// 강제 재발행: 인스타에서 지운 회차를 같은 날 같은 테마로 다시 올릴 때. 하루 1회 가드를
// 건너뛰고 그 테마의 오늘 행을 지운 뒤 새로 발행한다. 테마 지정(ROUNDUP_THEME) 없이는 무시.
const FORCE = process.env.ROUNDUP_FORCE === "1" && !!process.env.ROUNDUP_THEME;
// 오프라인 렌더용 사진 캐시. 클라우드 세션(claude.ai/code)은 네트워크 정책이
// tong.visitkorea.or.kr 같은 외부 호스트를 403으로 막는다 — 시크릿이 없는 게 아니라
// 그림 자체를 못 받는다. 그래서 OFFLINE 모드는 이 폴더의 파일을 먼저 쓰고, 없으면
// 짧게 네트워크를 시도하고(성공 시 여기 저장), 그래도 안 되면 색 플레이스홀더로
// 레이아웃만 렌더한다. 로컬(네트워크 있는) 세션에서 한 번 돌리면 캐시가 채워지니
// 커밋해 두면 클라우드에서도 실사진으로 검증할 수 있다.
const PHOTO_CACHE_DIR = new URL("../data/dry-sample-photos/", import.meta.url);

/**
 * 사진 한 장 → Buffer. 실패하면 null (호출부가 throw/skip을 결정).
 * OFFLINE 모드에서는 절대 null을 돌려주지 않는다 — 플레이스홀더라도 만든다.
 */
async function fetchPhoto(url, label = "") {
  if (!url) return OFFLINE ? placeholderPhoto(label) : null;
  let cacheFile = null;
  try { if (OFFLINE) cacheFile = new URL(path.basename(new URL(url).pathname), PHOTO_CACHE_DIR); } catch { /* 이상한 URL — 캐시 없이 진행 */ }
  if (cacheFile && fs.existsSync(cacheFile)) return fs.readFileSync(cacheFile);
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(OFFLINE ? 8000 : 20000) });
    if (!res.ok) throw new Error("http " + res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    if (cacheFile) {
      fs.mkdirSync(PHOTO_CACHE_DIR, { recursive: true });
      fs.writeFileSync(cacheFile, buf);
    }
    return buf;
  } catch (e) {
    if (!OFFLINE) return null;
    if (!fetchPhoto.warned) {
      fetchPhoto.warned = true;
      console.log(`  (사진 네트워크 불가 — 플레이스홀더로 렌더: ${e.message}. 실사진 검증은 data/dry-sample-photos/ 캐시를 채워서)`);
    }
    return placeholderPhoto(label);
  }
}

/** 오프라인 폴백: 따뜻한 단색 그라데이션 + 라벨 (레이아웃·서체 검증용, 발행에는 절대 안 쓰임) */
async function placeholderPhoto(label = "") {
  const sharp = (await import("sharp")).default;
  let h = 0;
  for (const ch of label) h = (h * 31 + ch.codePointAt(0)) % 360;
  const hue = 10 + (h % 40); // 주황~적갈 계열 (음식 사진 톤 근사)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="hsl(${hue},62%,48%)"/><stop offset="1" stop-color="hsl(${hue + 18},55%,28%)"/>
    </linearGradient></defs>
    <rect width="1200" height="900" fill="url(#g)"/>
    <circle cx="600" cy="450" r="260" fill="rgba(255,255,255,0.10)"/>
    <text x="600" y="470" text-anchor="middle" font-family="${FONT}" font-size="64" font-weight="700" fill="rgba(255,255,255,0.85)">${esc(label)}</text>
    <text x="600" y="540" text-anchor="middle" font-family="${FONT}" font-size="30" fill="rgba(255,255,255,0.6)">사진 플레이스홀더 (오프라인)</text>
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 80 }).toBuffer();
}
// 본문·설명: Pretendard / 제목·상호명·순위: G마켓 산스 (쇼츠 썸네일 유행 서체).
// 둘 다 assets/fonts/ 동봉 — 각 워크플로가 렌더 전에 설치한다. 미설치 환경은 Noto 폴백.
const FONT = "'Pretendard','Noto Sans CJK KR','NanumGothic','Malgun Gothic',sans-serif";
// 제목 서체 — 기본 G마켓 산스. COVER_TFONT env는 시안용 수동 지정, main()의
// 서체 A/B(G마켓 vs 잘난체 교대)가 회차별로 재할당한다 (let인 이유).
let TFONT = process.env.COVER_TFONT ||
  "'Gmarket Sans','Pretendard','Noto Sans CJK KR','Malgun Gothic',sans-serif";
const FONT_AB = {
  gmarket: "'Gmarket Sans','Pretendard','Noto Sans CJK KR','Malgun Gothic',sans-serif",
  jalnan: "'Jalnan','Pretendard','Noto Sans CJK KR','Malgun Gothic',sans-serif",
};

// 표지 스타일 순환. 배열 길이가 곧 주기이고, 포인터 이동도 이 길이를 쓴다.
//
// 실측(2026-09-07 cover-report, 발행 17건): classic 조회 평균 1,565(중앙값 약 800) vs
// hero 150 · pages 181 · dark 256. hero는 표본 4회 중 2회만 지표가 잡혔고 둘 다 150 안팎으로
// classic의 5분의 1이다. 그래서 hero 비중을 1/7 → 1/13으로 줄인다(2026-09-07 사용자 지시).
// 완전히 빼지 않는 이유: hero 회차는 카운트다운형(순차 공개) 렌더를 타는 유일한 모음집
// 경로라, 남겨 두면 포맷 비교를 계속할 수 있다. pages는 9/3에 시작한 A/B라 빈도를 유지하려고
// 13주기에 2번 넣었다(1/7 ≈ 2/13).
//
// ⚠️ 길이는 홀수를 유지할 것. 서체 A/B(font_idx %2)와 표지 포인터가 매 회차 함께 1씩
// 움직이므로, 주기가 짝수면 특정 표지에 특정 서체만 영원히 붙어 두 실험이 엉킨다.
const COVER_STYLES = [
  "classic", "classic", "pages", "classic", "classic", "classic", "hero",
  "classic", "classic", "pages", "classic", "classic", "classic",
];

const SIDO_SHORT = {
  서울특별시: "서울", 부산광역시: "부산", 대구광역시: "대구", 인천광역시: "인천",
  광주광역시: "광주", 대전광역시: "대전", 울산광역시: "울산", 세종특별자치시: "세종",
  경기도: "경기", 강원도: "강원", 강원특별자치도: "강원",
  충청북도: "충북", 충청남도: "충남", 전라북도: "전북", 전북특별자치도: "전북",
  전라남도: "전남", 경상북도: "경북", 경상남도: "경남",
  제주특별자치도: "제주", 제주도: "제주",
};

// 대표 사진 최소 가로 해상도. 서울 음식관광 DB(레드테이블) 사진은 메뉴 등록용 썸네일이라
// 릴스 1080px 풀블리드에 올리면 뭉개진다(9/3 성수 편 1위·6위 실측). 이보다 작은 후보는
// 비전에 보내기도 전에 제외 — TourAPI 원본(originimgurl)은 보통 이 기준을 넘는다.
const MIN_PHOTO_W = 900;
const BAD_IMG_NAME =
  /(화장실|주차|기저귀|수유|경사로|안내도|안내판|표지판|매표|엘리베이터|승강기|휠체어|점자|유도블록|소화전|진입로|비상|피난|보관함|안내소|계산대)/;

const toHttps = (u) => String(u ?? "").replace(/^http:/, "https:");
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const normName = (s) => String(s).replace(/\[[^\]]*\]/g, "").replace(/\s+/g, "");

function shortRegion(addr) {
  const parts = String(addr ?? "").split(/\s+/);
  const sido = SIDO_SHORT[parts[0]] ?? (parts[0] ?? "").slice(0, 2);
  const gu = (parts[1] ?? "").replace(/(특별자치)?(시|군|구)$/, "");
  return [sido, gu].filter(Boolean).join(" ");
}

/**
 * TourAPI 호출.
 * ⚠️ data.go.kr이 GitHub Actions 러너 IP를 간헐적으로 차단(ConnectTimeout)해
 *    발행이 통째로 실패한 적이 있다. 그래서 Vercel 프록시(/api/tour-proxy)를
 *    1순위로 쓰고, 실패하면 직접 호출로 폴백한다. 각 경로마다 2회씩 재시도.
 */
async function tourCall(endpoint, params, svc) {
  const base = (process.env.APP_BASE_URL || "https://insta-spot-bot.vercel.app").replace(/\/$/, "");
  const secret = process.env.CRON_SECRET;

  // 1순위: Vercel 프록시 (Actions IP 차단 우회)
  if (secret) {
    for (let i = 0; i < 2; i++) {
      try {
        const pq = new URLSearchParams({ endpoint, ...(svc ? { svc } : {}), ...params });
        const r = await fetch(`${base}/api/tour-proxy?${pq}`, {
          headers: { Authorization: `Bearer ${secret}` },
          signal: AbortSignal.timeout(40000),
        });
        if (r.ok) {
          const j = await r.json();
          if (Array.isArray(j.items)) return j.items;
        }
      } catch (e) {
        console.error(`[tour] 프록시 실패(${i + 1}):`, String(e).slice(0, 80));
      }
    }
  }

  // 폴백: 직접 호출
  let lastErr = null;
  for (let i = 0; i < 2; i++) {
    try {
      const qs = new URLSearchParams({
        serviceKey: process.env.TOUR_API_KEY,
        MobileOS: "ETC", MobileApp: "instaSpotBot", _type: "json", ...params,
      });
      const BASES = {
        korservice2: TOUR,
        photogallery: "https://apis.data.go.kr/B551011/PhotoGalleryService1",
        busanfood: "https://apis.data.go.kr/6260000/FoodService",
      };
      const base2 = BASES[svc ?? "korservice2"];
      const res = await fetch(`${base2}/${endpoint}?${qs}`, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`TourAPI ${endpoint} HTTP ${res.status}`);
      const json = await res.json();
      const items = svc === "busanfood" ? json?.getFoodKr?.item : json?.response?.body?.items?.item;
      return Array.isArray(items) ? items : items ? [items] : [];
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error(`TourAPI ${endpoint} 실패`);
}

/**
 * 테마 선택 가중치 — 지난 모음집의 "조회수"로 잘 통한 음식에 비중을 준다.
 *
 * 좋아요가 아니라 조회수를 쓰는 이유: 2026-08-18 짬뽕 모음집은 좋아요가 3개뿐인데
 * 조회 2,236·도달 1,444로 이 계정에서 유일하게 팔로워 밖까지 나갔다. 같은 주에
 * 좋아요 9개를 받은 게시물은 147회에 그쳤다. 이 계정에서 좋아요는 배포 성과와 무관하다.
 *
 * 과적합 방지: 중앙값 대비 배수에 log를 씌워 완화하고(한 번 터진 테마가 독점하지 않게),
 * 아직 안 해본 테마에는 중앙값 수준의 가중치를 줘 탐험을 유지한다.
 * 조회 실패·데이터 부족이면 null을 돌려 기존 단순 로테이션으로 돌아간다.
 */
async function themeWeights(db, all) {
  const token = process.env.IG_ACCESS_TOKEN;
  if (!token) return null;
  const known = new Set(all.map((t) => t.key));
  let rows;
  try {
    rows = (
      await db.execute(
        `SELECT content_id, ig_media_id FROM posts
          WHERE status = 'published' AND ig_media_id IS NOT NULL
            AND (content_id LIKE 'roundup-%' OR content_id LIKE 'countdown-%')
          ORDER BY id DESC LIMIT 30`
      )
    ).rows;
  } catch {
    return null;
  }
  if (!rows.length) return null;

  const stat = {};
  const recent = []; // 직전에 쓴 테마 (모음집·큐레이션 통합, 최근 2개)
  for (const r of rows) {
    // content_id = roundup-<테마키>-<날짜> (테마키에도 하이픈이 있어 뒤 날짜를 기준으로 자름).
    // 날짜는 20260818 형식이고, 초기 게시물에는 roundup-reel- 접두사도 있다.
    const m = String(r.content_id).match(/^(?:roundup|countdown)-(?:reel-)?(.+)-\d{4}-?\d{2}-?\d{2}$/);
    if (!m || !known.has(m[1])) continue;
    if (recent.length < 2 && !recent.includes(m[1])) recent.push(m[1]);
    try {
      const res = await fetch(
        `https://graph.instagram.com/v23.0/${r.ig_media_id}/insights?metric=views&access_token=${token}`,
        { signal: AbortSignal.timeout(15000) }
      );
      const v = (await res.json())?.data?.[0]?.values?.[0]?.value;
      if (typeof v === "number") (stat[m[1]] ??= []).push(v);
    } catch { /* 개별 실패는 건너뜀 */ }
  }

  const avgs = Object.entries(stat).map(([k, v]) => [k, v.reduce((a, b) => a + b, 0) / v.length]);
  if (avgs.length < 2) return null; // 비교 대상이 없으면 가중치 의미 없음
  const sorted = avgs.map(([, v]) => v).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] || 1;
  const byKey = Object.fromEntries(avgs);
  // 안 해본 테마의 사전 가중치 — 지역 인지도(시군구 방문자 수)로 매긴다.
  // 없으면 전부 2.0이라 대전 유성(조회 95)과 가로수길이 같은 확률로 뽑힌다.
  const prior = await visitorPrior(all);
  const weights = all.map((t) =>
    byKey[t.key] === undefined
      ? prior?.[t.key] ?? 2.0 // 실측 조회수가 없을 때만 사전 가중치
      : Math.min(6, 1 + Math.log2(1 + byKey[t.key] / median))
  );
  console.log(
    "테마 가중치(조회수):",
    all
      .map((t, i) => {
        const tag = byKey[t.key] !== undefined
          ? `(${Math.round(byKey[t.key])}회)`
          : prior?.[t.key] !== undefined ? "(미시도·방문자)" : "(미시도)";
        return `${t.key} ${weights[i].toFixed(1)}${tag}`;
      })
      .join(" · ")
  );
  return { weights, recent };
}

/**
 * 시군구 방문자 수 → 미시도 테마의 사전 가중치.
 * 조회수와 같은 스케일(중앙값 대비 log 배수)로 맞춰, 실측이 쌓이면 자연히 대체되게 한다.
 * 지역편(mode:"area")에만 적용 — 전국 음식 테마는 지역이 없어 의미가 없다.
 * 데이터·키·카카오 어느 하나라도 없으면 null → 기존 평탄한 2.0 유지.
 */
async function visitorPrior(all) {
  const areas = all.filter((t) => t.mode === "area");
  if (areas.length < 2) return null;
  try {
    // 키가 없으면 조용히 꺼지는 대신 이유를 남긴다 — 왜 가중치가 안 붙는지 로그로 알 수 있게.
    if (!process.env.KAKAO_REST_KEY) {
      console.log("[visitors] KAKAO_REST_KEY 없음 — 지역 해석 불가로 사전 가중치 생략");
      return null;
    }
    const { fetchVisitorStats, resolveThemeRegions, lookupVisitors } = await import("../lib/visitors.ts");
    const stats = await fetchVisitorStats();
    if (!stats) return null;
    const regions = await resolveThemeRegions(areas);
    // 시군구는 이름만으로 식별되지 않는다(중구·동구는 여러 시에 있다) — 시도까지 맞고
    // 후보가 하나일 때만 값을 준다. 모호하면 null이라 그 테마는 기존 2.0으로 남는다.
    const got = areas
      .map((t) => [t.key, regions[t.key] ? lookupVisitors(stats, regions[t.key]) : null])
      .filter(([, v]) => typeof v === "number" && v > 0);
    const ambiguous = areas.length - got.length;
    if (ambiguous) console.log(`[visitors] 지역 미확정 ${ambiguous}곳 — 해당 테마는 기존 가중치 유지`);
    if (got.length < 3) return null; // 표본이 적으면 비교가 안 된다
    const sortedV = got.map(([, v]) => v).sort((a, b) => a - b);
    const med = sortedV[Math.floor(sortedV.length / 2)] || 1;
    // 실측(최대 6)보다 좁은 폭(0.8~4.0) — 사전 정보일 뿐이라 실측을 이기면 안 된다
    return Object.fromEntries(
      got.map(([k, v]) => [k, Math.max(0.8, Math.min(4, 1 + Math.log2(1 + v / med)))])
    );
  } catch (e) {
    console.error("[visitors] 사전 가중치 실패(무시):", String(e).slice(0, 120));
    return null;
  }
}

/** 가중 랜덤으로 중복 없이 시도 순서를 만든다 (첫 자리는 최근에 쓴 테마 제외) */
function weightedOrder(all, weights, exclude = []) {
  const draw = (pool) => {
    const out = [];
    while (pool.length) {
      const total = pool.reduce((a, b) => a + b.w, 0);
      let r = Math.random() * total;
      let pick = pool[pool.length - 1];
      for (const p of pool) {
        r -= p.w;
        if (r <= 0) { pick = p; break; }
      }
      out.push(pick.t);
      pool.splice(pool.indexOf(pick), 1);
    }
    return out;
  };
  const items = all.map((t, i) => ({ t, w: weights[i] }));
  // 최근에 쓴 테마는 맨 뒤로 — 앞 테마가 수집에 실패해도 곧바로 다시 나오지 않게
  return [
    ...draw(items.filter((p) => !exclude.includes(p.t.key))),
    ...draw(items.filter((p) => exclude.includes(p.t.key))),
  ];
}

// ===== 비짓제주 API (제주관광공사 — 음식점 1,869곳, 사진·태그·소개 포함) =====
// 제주 한정 테마(areaCode=39)의 수집 풀 보강용. TourAPI 제주 풀은 흑돼지 9곳으로
// 6칸도 못 채웠는데, 이 소스가 흑돼지 201곳·물회 80곳·갈치 156곳을 준다(2026-08 실측).
// api.visitjeju.net은 data.go.kr이 아니라 Actions에서 직접 호출 가능(프록시 불필요).

let jejuCache = null;
async function jejuPlaces(keyword) {
  if (!process.env.JEJU_API_KEY) return [];
  if (!jejuCache) {
    jejuCache = [];
    for (let p = 1; p <= 19; p++) {
      for (let a = 0; a < 3; a++) {
        try {
          const r = await fetch(
            `https://api.visitjeju.net/vsjApi/contents/searchList?apiKey=${process.env.JEJU_API_KEY}&locale=kr&category=c4&page=${p}`,
            { signal: AbortSignal.timeout(30000) }
          );
          const j = await r.json();
          jejuCache.push(...(j.items ?? []));
          break;
        } catch { await new Promise((s) => setTimeout(s, 1200)); } // 페이지 단위 재시도, 일부 실패해도 풀은 충분
      }
      await new Promise((s) => setTimeout(s, 200));
    }
    console.log(`[jeju] 캐시: ${jejuCache.length}곳`);
  }
  const clean = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
  const BAD = /(카페|커피|디저트|베이커리|빵집|브런치|주점|술집|펍)/;
  return jejuCache
    .filter((it) => it.repPhoto?.photoid?.imgpath)
    .filter((it) => !BAD.test(`${it.title} ${it.tag ?? ""}`))
    .filter((it) => `${it.title} ${it.alltag ?? ""} ${it.introduction ?? ""}`.includes(keyword))
    .map((it) => ({
      contentId: `jeju-${it.contentsid}`,
      name: clean(it.title),
      address: clean(it.roadaddress || it.address),
      region: shortRegion(it.roadaddress || it.address),
      imageUrl: String(it.repPhoto.photoid.imgpath),
      lat: Number(it.latitude) || null, lng: Number(it.longitude) || null,
      // 태그는 공식 메타데이터라 설명 근거로 붙여준다 (메뉴 필드는 없음 — 지어내기 방지 위해 비움)
      overview: `${clean(it.introduction)}${it.tag ? ` (키워드: ${clean(it.tag)})` : ""}`.slice(0, 300),
    }));
}

// ===== 부산맛집 API (비짓부산 미식투어 437곳 — 사진·대표메뉴·영업시간·소개 포함) =====
// 부산 한정 테마(areaCode=6)의 수집 풀 보강용. TourAPI 부산 풀은 돼지국밥 8곳·밀면
// 6곳으로 얇았는데, 이 소스가 각각 19곳·15곳을 더 준다(2026-08 실측).

// ===== 경주 먹거리 핫플레이스 (경주시, 61곳 — 사진·좌표·대표메뉴 포함) =====
// 황리단길 상권이 TourAPI만으로는 21곳이라 얇았다. 이 소스가 식당 13곳을 더 준다(실측 2026-09-09).
// 사진 URL에 스킴이 없어 https:// 를 붙여야 하고, 약 1/3은 404라 살아있는 것만 남긴다.
let gyeongjuCache = null;
let gyeongjuAlive = null;
async function gyeongjuPlaces() {
  if (!gyeongjuCache) {
    try {
      const u = `https://apis.data.go.kr/5050000/eatHtpService/getEatHtp?serviceKey=${encodeURIComponent(process.env.TOUR_API_KEY ?? "")}&pageNo=1&numOfRows=200`;
      const j = await (await fetch(u, { signal: AbortSignal.timeout(25000) })).json();
      const it = j.response?.body?.items?.item ?? j.body?.items?.item;
      gyeongjuCache = Array.isArray(it) ? it : it ? [it] : [];
      console.log(`[gyeongju] 캐시: ${gyeongjuCache.length}곳`);
    } catch (e) {
      console.error("[gyeongju] 수집 실패(건너뜀):", String(e).slice(0, 90));
      gyeongjuCache = [];
    }
  }
  const clean = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
  const mapped = gyeongjuCache
    .filter((x) => x.CON_IMGFILENAME && x.CON_LATITUDE && x.CON_LONGITUDE)
    .map((x) => ({
      contentId: `gyeongju-${x.CON_UID}`,
      name: clean(x.CON_TITLE),
      address: clean(x.CON_DESC1),
      region: shortRegion(clean(x.CON_DESC1)) || "경북 경주",
      imageUrl: /^https?:/.test(String(x.CON_IMGFILENAME)) ? String(x.CON_IMGFILENAME) : "https://" + String(x.CON_IMGFILENAME).replace(/^\/+/, ""),
      lat: Number(x.CON_LATITUDE) || null,
      lng: Number(x.CON_LONGITUDE) || null,
    }));
  // 살아있는 사진만 (8개씩 병렬 — 61곳이라 몇 초면 끝난다). 한 번만 하고 캐시에 굳힌다.
  if (!gyeongjuAlive) {
    const alive = [];
    for (let i = 0; i < mapped.length; i += 8) {
      const chunk = mapped.slice(i, i + 8);
      const oks = await Promise.all(chunk.map(async (p) => {
        try {
          const r = await fetch(p.imageUrl, { signal: AbortSignal.timeout(10000) });
          return r.ok && Number(r.headers.get("content-length") ?? 99999) > 5000;
        } catch { return false; }
      }));
      chunk.forEach((p, k) => oks[k] && alive.push(p));
    }
    gyeongjuAlive = alive;
    console.log(`[gyeongju] 사진 살아있는 곳: ${alive.length}/${mapped.length}`);
  }
  return gyeongjuAlive;
}

let busanCache = null;
async function busanPlaces(keyword) {
  if (!busanCache) {
    try {
      busanCache = await tourCall("getFoodKr", { pageNo: "1", numOfRows: "500", resultType: "json" }, "busanfood");
    } catch (e) {
      console.error("[busan] 수집 실패(건너뜀):", String(e).slice(0, 100));
      busanCache = [];
    }
  }
  const clean = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
  return busanCache
    .filter((it) => `${it.MAIN_TITLE} ${it.RPRSNTV_MENU} ${it.ITEMCNTNTS}`.includes(keyword))
    .filter((it) => it.MAIN_IMG_NORMAL)
    .map((it) => ({
      contentId: `busan-${it.UC_SEQ}`,
      name: clean(it.MAIN_TITLE),
      address: `부산 ${clean(it.GUGUN_NM)} ${clean(it.ADDR1)}`,
      region: `부산 ${clean(it.GUGUN_NM).replace(/(구|군)$/, "")}`,
      imageUrl: String(it.MAIN_IMG_NORMAL),
      lat: Number(it.LAT) || null, lng: Number(it.LNG) || null,
      // 설명·캡션 재료가 이미 갖춰져 있어 enrichPlaces의 TourAPI 조회가 불필요
      menu: clean(it.RPRSNTV_MENU).slice(0, 60),
      overview: clean(it.ITEMCNTNTS).slice(0, 300),
      hours: clean(it.USAGE_DAY_WEEK_AND_TIME).slice(0, 80),
    }));
}

/**
 * 포토코리아(관광공사 관광사진, 공공누리 1유형) — 표지 배경용 음식 사진.
 * TourAPI 식당 원본보다 촬영 품질이 압도적이라 표지 첫인상이 좋아진다.
 * 출처표시 의무가 있어 캡션에 크레딧 라인을 붙인다. 실패하면 null(기존 배경 유지).
 */
async function photoKoreaPhoto(keyword) {
  try {
    const items = await tourCall(
      "gallerySearchList1",
      { keyword, numOfRows: "30", pageNo: "1", arrange: "A" },
      "photogallery"
    );
    // 검색이 촬영지·태그까지 잡아 관광지 컷이 섞인다(실측: "흑돼지" → 휴애리 자연생활공원).
    // 제목에 키워드가 든 사진만 — 없으면 배경 교체를 포기(식당 사진 유지)하는 게 안전.
    const good = (items ?? []).filter(
      (it) => it.galWebImageUrl && String(it.galTitle ?? "").includes(keyword)
    );
    if (!good.length) return null;
    // 제목 필터만으론 부족 — "보쌈골목"처럼 키워드가 든 거리·시장 전경이 통과한다
    // (실측: 보쌈 히어로 배경이 골목 사진으로 나감). 비전 음식 검사 통과분만 쓴다.
    const { pickFoodImages } = await import("../lib/vision.ts");
    const shuffled = good.slice(0, 8).sort(() => Math.random() - 0.5);
    const foodUrls = await pickFoodImages(shuffled.map((it) => String(it.galWebImageUrl)), 3);
    if (!foodUrls.length) {
      console.log("[photokorea] 음식 컷 없음(관광 전경뿐) — 기존 배경 유지");
      return null;
    }
    const pick = good.find((it) => String(it.galWebImageUrl) === foodUrls[0]);
    return {
      url: foodUrls[0],
      photographer: String(pick?.galPhotographer ?? "").trim(),
      title: String(pick?.galTitle ?? "").trim(),
    };
  } catch (e) {
    console.error("[photokorea] 검색 실패(기존 배경 유지):", String(e).slice(0, 80));
    return null;
  }
}

/** 테마에 맞는 식당 수집 (사진 + 공공누리 Type1/3, 시군구당 최대 2곳) */
/**
 * 지역편(mode:"area") 수집 — 음식을 하나로 묶지 않고 "그 동네 맛집" (2026-09-03 사용자 지시).
 * 시·군·구(areaBasedList2) 또는 좌표 반경(locationBasedList2, 상권 1.5km)으로 음식점(39)을
 * 긁는다. 실측 풀: 강릉 67·경주 94·수원 188·강남 159 / 성수 121·을지로 52·익선 48 (사진 보유).
 * 같은 동네라 시군구 상한은 걸지 않는다. 지자체 보강 소스·포토코리아는 안 쓴다.
 */
// 순수 음식점만 (사용자 정책: 카페·제과·주점 제외) — TourAPI cat3 + 상호 정규식. 보조 소스(부산·제주·서울 DB)
// 에도 상호 필터를 건다 (실측: 비짓제주에서 노티드·라운지 바, 서울 DB에서 카페 드 파리가 새어 들어옴).
const AREA_BAD_CAT = /^A0502(0900|1000)/;
const AREA_BAD_NAME = /(카페|까페|cafe|coffee|커피|로스터|베이커리|bakery|제과|과자|빵집|디저트|dessert|케이크|도넛|노티드|와플|공방|아이스크림|젤라또|치즈|초콜|티하우스|찻집|다방|와인바|라운지|lounge|펍|pub|호프|바(?![가-힣A-Za-z0-9])|주점|술집|포차|맥주|브런치)/i;

async function collectAreaPlaces(theme, limit) {
  const t = theme.tour ?? {};
  const params = { contentTypeId: "39", numOfRows: "200", arrange: "O" };
  let ep = "areaBasedList2";
  if (t.mapX && t.mapY) {
    ep = "locationBasedList2";
    Object.assign(params, { mapX: String(t.mapX), mapY: String(t.mapY), radius: String(t.radius ?? 1500) });
  } else {
    Object.assign(params, { areaCode: String(t.areaCode), sigunguCode: String(t.sigunguCode) });
  }
  let items = [];
  try {
    items = await tourCall(ep, params);
  } catch (e) {
    console.error(`[collect:area] ${theme.key} 실패:`, String(e).slice(0, 80));
    return [];
  }
  // 순수 음식점만 (사용자 정책: 카페·제과·주점 제외). 지역편은 음식 키워드가 없어
  // 카페·디저트가 그대로 섞여 들어온다(실측: 강릉 풀의 절반이 카페) — 분류코드와 상호로 거른다.
  //   cat3 A05020900 카페/전통찻집, A05021000 클럽
  items = items.filter(
    (it) =>
      it.firstimage &&
      (it.cpyrhtDivCd === "Type1" || it.cpyrhtDivCd === "Type3") &&
      !AREA_BAD_CAT.test(String(it.cat3 ?? "")) &&
      !AREA_BAD_NAME.test(String(it.title ?? ""))
  );
  // 보조 소스 반경 합류 (2026-09-03): TourAPI가 얇은 상권(서면·광안리·애월 등)을
  // 부산맛집 API·비짓제주·서울 음식관광 DB로 채운다. 좌표 있는 상권 테마에서만.
  const extra = (t.mapX && t.mapY ? await supplementNearby(theme, Number(t.mapX), Number(t.mapY), Number(t.radius ?? 1500)) : [])
    .filter((p) => !AREA_BAD_NAME.test(String(p.name)));
  const picked = [];
  const names = new Set();
  // 보조 소스는 풀의 절반까지만 — 나머지는 TourAPI(공공누리 사진)로 섞어 소스 편중을 막는다.
  // 단 TourAPI가 얇은 상권(서면·애월 등 실측 6~10곳)은 보조 소스가 부족분을 메운다.
  const want = limit ?? theme.count;
  const extraCap = Math.max(Math.ceil(want / 2), want - items.length);
  for (const b of extra.sort(() => Math.random() - 0.5)) {
    if (picked.length >= extraCap) break;
    names.add(normName(b.name));
    picked.push(b);
  }
  for (const it of items.sort(() => Math.random() - 0.5)) {
    if (picked.length >= (limit ?? theme.count)) break;
    const nm = String(it.title).replace(/\[[^\]]*\]/g, "").trim();
    if (names.has(normName(nm))) continue; // 보조 소스와 중복
    picked.push({
      contentId: String(it.contentid),
      name: nm,
      address: [it.addr1, it.addr2].filter(Boolean).join(" "),
      region: shortRegion(it.addr1),
      imageUrl: toHttps(it.firstimage),
    });
  }
  if (extra.length) console.log(`[collect:area] 보조 소스 ${extra.length}곳 합류 (${theme.region})`);
  return picked;
}

/** 두 좌표 사이 거리(m) */
function distM(lat1, lng1, lat2, lng2) {
  const R = 6371000, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** 상권 좌표 반경 안의 보조 소스 식당 — 지역(시도)에 맞는 소스만 조회한다 */
async function supplementNearby(theme, x, y, radius) {
  const region = String(theme.region ?? "");
  const out = [];
  try {
    if (region.startsWith("부산")) {
      for (const p of await busanPlaces("")) if (p.lat && p.lng && distM(y, x, p.lat, p.lng) <= radius) out.push(p);
    } else if (region.startsWith("제주")) {
      for (const p of await jejuPlaces("")) if (p.lat && p.lng && distM(y, x, p.lat, p.lng) <= radius) out.push(p);
    } else if (region.startsWith("강원")) {
      const { wonjuNearby } = await import("../lib/wonjufood.ts");
      for (const p of wonjuNearby(y, x, radius)) {
        out.push({
          contentId: `wonju-${p.id}`,
          name: String(p.name).trim(),
          address: String(p.addr),
          region: shortRegion(p.addr),
          imageUrl: p.imgs[0],
          extraImages: p.imgs.slice(1, 6), // 비전이 음식 컷을 고르도록 나머지 사진도 후보로
          overview: String(p.intro ?? "").slice(0, 300),
        });
      }
    } else if (region.startsWith("경북")) {
      for (const p of await gyeongjuPlaces()) if (p.lat && p.lng && distM(y, x, p.lat, p.lng) <= radius) out.push(p);
    } else if (region.startsWith("서울")) {
      const { seoulNearby } = await import("../lib/seoulfood.ts");
      for (const p of seoulNearby(y, x, radius)) {
        out.push({
          contentId: `seoul-${p.id}`,
          name: String(p.name).trim(),
          address: String(p.addr),
          region: shortRegion(p.addr),
          imageUrl: p.imgs[0],
          extraImages: p.imgs.slice(1, 6), // 비전이 음식 컷을 고르도록 나머지 사진도 후보로
          overview: p.intro && !/(찾으신다면|추천합니다!|가 ?볼 ?만한)/.test(p.intro) ? String(p.intro).slice(0, 300) : "",
        });
      }
    }
  } catch (e) {
    console.error("[collect:area] 보조 소스 실패(무시):", String(e).slice(0, 80));
  }
  return out;
}

async function collectPlaces(theme, limit) {
  if (theme.mode === "area") return collectAreaPlaces(theme, limit);
  // 지역 시리즈(2026-09): areaCodes 배열로 여러 시도를 묶는다 (영남=부산·대구·울산·경북·경남 등).
  // TourAPI는 areaCode를 하나만 받아 코드별로 호출해 합친다.
  const codes = theme.areaCodes ?? (theme.areaCode ? [theme.areaCode] : [null]);
  // 지역 한정 테마는 지자체 관광 API(사진 보장)를 풀 앞에 합류
  const extra = [
    ...(codes.includes(6) ? await busanPlaces(theme.keyword) : []),
    ...(codes.includes(39) ? await jejuPlaces(theme.keyword) : []),
  ];
  let items = [];
  for (const c of codes) {
    const params = { keyword: theme.keyword, contentTypeId: "39", numOfRows: "100", arrange: "R" };
    if (c) params.areaCode = String(c);
    try {
      items.push(...(await tourCall("searchKeyword2", params)));
    } catch (e) {
      console.error(`[collect] areaCode=${c} 실패(건너뜀):`, String(e).slice(0, 80));
    }
  }
  items = items.filter(
    (it) => it.firstimage && (it.cpyrhtDivCd === "Type1" || it.cpyrhtDivCd === "Type3")
  );
  const seen = {};
  const picked = [];
  const names = new Set();
  // 보조 소스(부산·제주 API)는 풀의 절반까지만 — 영남·호남 권역 테마가 부산으로만 채워지던 문제 방지
  const extraCap = Math.ceil((limit ?? theme.count) / 2);
  for (const b of extra.sort(() => Math.random() - 0.5)) {
    if (picked.length >= extraCap) break;
    // 지자체 보강 소스는 지역 상한을 안 건다 — 제주는 시군구가 2개뿐이라 4곳 상한이면
    // 풀이 9곳으로 잘려 비전 탈락 후 6칸을 못 채운다(실측). 테마 자체가 지역 한정이라
    // 카드가 같은 지역이어도 자연스럽다.
    names.add(normName(b.name));
    picked.push(b);
  }
  // 시군구 편중 방지 상한. 지역 한정 테마(areaCode)는 시군구 수 자체가 적어
  // 2곳으로 묶으면 6곳을 채울 수 없다 (제주=제주시·서귀포시 2개뿐 → 최대 4곳).
  const perRegion = theme.areaCode || theme.areaCodes ? 4 : 2;
  for (const it of items.sort(() => Math.random() - 0.5)) {
    const rg = shortRegion(it.addr1);
    if ((seen[rg] ?? 0) >= perRegion) continue;
    if (names.has(normName(it.title))) continue; // 보조 소스와 중복
    seen[rg] = (seen[rg] ?? 0) + 1;
    picked.push({
      contentId: String(it.contentid),
      name: String(it.title).replace(/\[[^\]]*\]/g, "").trim(),
      address: [it.addr1, it.addr2].filter(Boolean).join(" "),
      region: rg,
      imageUrl: toHttps(it.firstimage),
    });
    if (picked.length >= (limit ?? theme.count)) break;
  }
  return picked;
}

/** 백년가게 목록(DB 캐시)과 대조 → 해당 가게에 hundred 플래그 */
async function markHundredYear(db, places) {
  try {
    const r = await db.execute("SELECT value FROM config WHERE key = 'hys_list'");
    if (!r.rows.length) return;
    const names = JSON.parse(String(r.rows[0].value)).map((e) => normName(e.name));
    for (const p of places) {
      const pn = normName(p.name);
      if (names.some((n) => n && (pn.includes(n) || n.includes(pn)))) p.hundred = true;
    }
  } catch {
    /* 무시 */
  }
}

/** 가게별 이미지 중 Gemini 비전으로 음식 사진 선택 (실패 시 기존 유지) */
async function pickFoodImage(place, food) {
  try {
    // 지자체 소스(busan-·jeju-)는 TourAPI 콘텐츠가 아니라 추가 이미지 조회가 없다 — 대표 1장만 검사
    const items = /^(busan|jeju|seoul|gyeongju|wonju)-/.test(place.contentId)
      ? []
      : await tourCall("detailImage2", {
          contentId: place.contentId, imageYN: "Y", numOfRows: "15",
        });
    const cands = [
      { url: place.imageUrl, small: place.imageUrl },
      ...(place.extraImages ?? []).map((u) => ({ url: u, small: u })),
      ...items
        .filter((it) => !(it.imgname && BAD_IMG_NAME.test(it.imgname)))
        .map((it) => ({
          url: toHttps(it.originimgurl || it.smallimageurl),
          small: toHttps(it.smallimageurl || it.originimgurl),
        })),
    ]
      .filter((v, i, a) => v.url && a.findIndex((x) => x.url === v.url) === i)
      .slice(0, 5); // Groq 비전 폴백이 요청당 5장까지라 맞춤
    if (cands.length < 1 || !(process.env.GEMINI_API_KEY || process.env.GROQ_KEY)) return;
    const sharp = (await import("sharp")).default;
    // 해상도 게이트 — 작은 사진은 아무리 음식이 잘 보여도 릴스 풀블리드에 못 쓴다.
    // 비전에는 썸네일(small)을 보내므로 크기는 반드시 '원본(url)'으로 재야 한다
    // (썸네일로 재면 TourAPI 후보가 전부 150px로 걸러진다 — 9/3 DRY 실측).
    const wideEnough = async (buf, url) => {
      const meta = await sharp(buf).metadata();
      if ((meta.width ?? 0) >= MIN_PHOTO_W) return true;
      console.log(`  저해상도 제외(${meta.width}px): ${url.slice(-48)}`);
      return false;
    };

    const valid = [], parts = [];
    for (const c of cands) {
      try {
        const res = await fetch(c.small, { signal: AbortSignal.timeout(15000) });
        if (!res.ok) continue;
        let b = Buffer.from(await res.arrayBuffer());
        // 비전용 사본이 곧 원본인 후보(대표 사진·지자체 소스)는 여기서 바로 거른다
        if (c.small === c.url && !(await wideEnough(b, c.url))) continue;
        // 비짓제주는 webp, 일부 원본은 4MB급 — JPEG로 통일·축소해서 비전에 넘긴다
        if (b.length > 900_000 || !(b[0] === 0xff && b[1] === 0xd8)) {
          b = await sharp(b).resize(720, 720, { fit: "inside" }).jpeg({ quality: 78 }).toBuffer();
        }
        valid.push(c);
        parts.push({ inlineData: { mimeType: "image/jpeg", data: b.toString("base64") } });
      } catch { /* skip */ }
    }
    if (valid.length < 1) return;

    const visionParts = [
          { text: `식당 사진 ${valid.length}장이야. ${food ? `"${food}" 요리가 실제로 화면에 보이는 사진의 번호만 좋은 순서대로 JSON 배열로 답해 (1번부터). 반찬·곁들임·다른 요리만 보이는 사진은 제외하고, ${food}가 보이는 사진이 한 장도 없으면 반드시 []로 답해.` : `음식(요리·메뉴)이 크고 먹음직스럽게 보이는 사진의 번호를 좋은 순서대로 JSON 배열로만 답해 (1번부터).`} 제외 대상: 건물 외관·간판·내부 전경, 메뉴판, 블로그·업체 워터마크나 로고 글자가 박힌 사진. 조건에 맞는 사진이 없으면 []. 예: [3,1]` },
          ...parts,
        ];
    let text = await geminiCall(visionParts, 60);
    if (!text) text = await groqVision(visionParts, 60); // Gemini 과부하 시 무료 Groq 비전으로
    text = (text ?? "").replace(/<think>[\s\S]*?<\/think>/g, "");
    const arrs = [...text.matchAll(/\[[\d,\s]*\]/g)];
    const m = arrs.length ? arrs[arrs.length - 1] : null;
    let order = [];
    try { order = m ? JSON.parse(m[0]) : []; } catch { order = []; }
    // 비전이 고른 순서대로 원본 해상도를 확인해 첫 합격을 채택 (원본은 여기서만 받는다)
    let best = null;
    for (const n of order) {
      const cand = valid[Number(n) - 1];
      if (!cand?.url) continue;
      if (cand.small === cand.url) { best = cand; break; } // 위에서 이미 검사됨
      try {
        const r = await fetch(cand.url, { signal: AbortSignal.timeout(20000) });
        if (!r.ok) continue;
        if (await wideEnough(Buffer.from(await r.arrayBuffer()), cand.url)) { best = cand; break; }
      } catch { /* 다음 후보 */ }
    }
    if (best?.url) {
      place.imageUrl = best.url;
      place.foodPicked = true;
    }
  } catch { /* 기존 이미지 유지 */ }
}

/**
 * Gemini 호출 (텍스트/비전 공용). thinking 없는 경량 모델(gemini-flash-lite-latest) 기본.
 * gemini-flash-latest는 thinking 전용이라 긴 출력이 잘리고 thinkingBudget:0에 400을
 * 반환하므로(2026-07 실측), env에 그 값이 있어도 무시하고 경량 모델로 자동 교정.
 * thinkingConfig는 최신 모델들이 400을 내므로 아예 보내지 않음.
 */
function geminiModel() {
  const m = process.env.GEMINI_MODEL;
  return m && m !== "gemini-flash-latest" ? m : "gemini-flash-lite-latest";
}
// Gemini 과부하(503 high demand)·타임아웃은 몇 초 뒤 다시 부르면 되는 경우가 많다
// (9/2 런 #34, 9/4 런 #61: 24곳 중 22곳이 503으로 비전 탈락 → 발행 건너뜀).
// 다만 러너 15분 제한이 있어 런 전체 재시도 횟수에 상한을 둔다.
let geminiRetryBudget = 8;
// 연속 실패 회로 차단: 503·타임아웃이 3번 연달아 나면 이번 런은 Gemini를 더 부르지 않는다.
// (9/4 DRY #65 실측: 곳마다 40초 타임아웃+재시도로 60초씩 써서 24곳에 15분 제한 초과)
let geminiConsecutiveFail = 0;
async function geminiCall(parts, maxTokens) {
  if (!process.env.GEMINI_API_KEY) return null;
  if (geminiConsecutiveFail >= 3) {
    if (geminiConsecutiveFail === 3) { console.log("[llm] Gemini 연속 3회 실패 — 이번 런은 Groq로만 진행"); geminiConsecutiveFail++; }
    return null;
  }
  for (let attempt = 0; ; attempt++) {
    let retryable = false;
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel()}:generateContent?key=${process.env.GEMINI_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contents: [{ parts }], generationConfig: { maxOutputTokens: maxTokens } }),
          signal: AbortSignal.timeout(30000),
        }
      );
      const j = await res.json();
      if (j?.error) {
        console.log("[llm] Gemini 실패:", j.error.code ?? "", String(j.error.message ?? "").slice(0, 80));
        retryable = j.error.code === 503 || j.error.code === 429 || /UNAVAILABLE|RESOURCE_EXHAUSTED/.test(String(j.error.status ?? ""));
      } else {
        const cand = j?.candidates?.[0];
        const t = (cand?.content?.parts?.filter((p) => !p.thought).map((p) => p.text ?? "").join("") ?? "").trim();
        if (t && cand?.finishReason === "STOP") { geminiConsecutiveFail = 0; return t; }
        if (t && cand?.finishReason) console.log("[llm] Gemini 응답 잘림:", cand.finishReason);
        return null;
      }
    } catch (e) {
      console.log("[llm] Gemini 오류:", String(e).slice(0, 80));
      retryable = /TimeoutError|fetch failed|ECONNRESET/.test(String(e));
    }
    if (!retryable || attempt >= 1 || geminiRetryBudget <= 0) { if (retryable) geminiConsecutiveFail++; return null; }
    geminiRetryBudget--;
    const wait = 6000 + attempt * 6000;
    console.log(`[llm] Gemini ${wait / 1000}초 후 재시도 (남은 예산 ${geminiRetryBudget})`);
    await new Promise((r) => setTimeout(r, wait));
  }
}

/**
 * 비전 폴백: Gemini가 과부하(503)면 Groq 무료 멀티모달로 같은 판정을 한다.
 * (9/4 밤 실측: 재시도 8회를 다 써도 Gemini 전멸 → 발행 건너뜀. 텍스트는 Groq 폴백이
 *  있었는데 사진 판정만 없었다.) parts는 geminiCall과 같은 형식, 이미지는 5장까지.
 */
// Groq 모델 id는 자주 바뀐다. 9/4 실측: llama-4-scout는 "does not exist", 텍스트 기본값이던
// llama-3.3-70b-versatile은 2026-08 서비스 종료(권장 대체: openai/gpt-oss-120b, qwen/qwen3.6-27b —
// qwen3.6-27b는 이미지 입력도 됨). 그래서 고정하지 않고 /models 목록에서 고른다.
// GROQ_MODEL(텍스트)·GROQ_VISION_MODEL(비전)로 고정 지정 가능.
let groqModelIds = null;
async function groqModels() {
  if (groqModelIds) return groqModelIds;
  try {
    const res = await fetch("https://api.groq.com/openai/v1/models", {
      headers: { Authorization: `Bearer ${process.env.GROQ_KEY}` },
      signal: AbortSignal.timeout(15000),
    });
    const j = await res.json();
    groqModelIds = (j?.data ?? []).map((m) => String(m.id)).filter((id) => !/guard|whisper|tts|embed|safeguard/i.test(id));
    console.log(`[llm] Groq 모델 목록 ${groqModelIds.length}개: ${groqModelIds.join(", ")}`);
  } catch (e) {
    console.log("[llm] Groq 모델 목록 실패:", String(e).slice(0, 80));
    groqModelIds = [];
  }
  return groqModelIds;
}
const pickModel = (ids, prefs) => { for (const p of prefs) { const hit = ids.find((id) => p.test(id)); if (hit) return hit; } return null; };
async function resolveGroqVisionModel() {
  if (process.env.GROQ_VISION_MODEL) return process.env.GROQ_VISION_MODEL;
  const pick = pickModel(await groqModels(), [/qwen3\.6/i, /qwen.*vl/i, /llama-4.*(maverick|scout)/i, /llama-4/i, /vision/i]);
  if (!pick) console.log("[llm] Groq 비전 모델 없음");
  return pick;
}
async function resolveGroqTextModel() {
  if (process.env.GROQ_MODEL) return process.env.GROQ_MODEL;
  return pickModel(await groqModels(), [/gpt-oss-120b/i, /qwen3\.6/i, /gpt-oss-20b/i, /llama-3\.3-70b/i, /llama/i, /./]);
}
// Groq 비전은 무료 등급이라 호출마다 한도 대기가 붙는다(9/4 실측 20~30초). 런당 상한을 둬서
// Gemini 장기 장애 때 빨리 건너뛰고 다음 예약 슬롯(1시간 간격)이 재시도하게 한다.
let groqVisionCalls = 0;
const GROQ_VISION_MAX_CALLS = 10;
async function groqVision(parts, maxTokens) {
  if (!process.env.GROQ_KEY) return null;
  if (groqVisionCalls >= GROQ_VISION_MAX_CALLS) {
    if (groqVisionCalls === GROQ_VISION_MAX_CALLS) { console.log(`[llm] Groq 비전 런당 상한(${GROQ_VISION_MAX_CALLS}회) 도달 — 이후 생략`); groqVisionCalls++; }
    return null;
  }
  groqVisionCalls++;
  const model = await resolveGroqVisionModel();
  if (!model) return null;
  const sharp = (await import("sharp")).default;
  // 무료 등급 한도 대응 (9/4 실측: 720px 3장이면 'Request too large'·rate limit, 응답은 thinking에
  // 잘림) — 2장·512px로 줄이고 사고를 끈다. qwen3.6-27b는 이미지 3장 상한이기도 하다.
  // 프롬프트의 장수도 맞춘다 (번호는 1번부터 그대로 대응)
  const MAX_IMGS = 2;
  const imgParts = parts.filter((p) => p.inlineData).slice(0, MAX_IMGS);
  if (!imgParts.length) return null;
  const content = [];
  for (const p of parts) if (p.text) content.push({ type: "text", text: p.text.replace(/식당 사진 \d+장/, `식당 사진 ${imgParts.length}장`) });
  for (const p of imgParts) {
    let b = Buffer.from(p.inlineData.data, "base64");
    try { b = await sharp(b).resize(512, 512, { fit: "inside" }).jpeg({ quality: 70 }).toBuffer(); } catch { /* 원본 그대로 */ }
    content.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${b.toString("base64")}` } });
  }
  const body = { model, messages: [{ role: "user", content }], max_tokens: Math.max(maxTokens, 512), temperature: 0, reasoning_effort: "none" };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.GROQ_KEY}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(40000),
      });
      const j = await res.json();
      if (j?.error) {
        const msg = String(j.error.message ?? "");
        if (/reasoning/i.test(msg) && body.reasoning_effort) {
          delete body.reasoning_effort; body.max_tokens = 2048; // 모델이 파라미터를 모르면 빼고 재시도
          continue;
        }
        if (/rate limit|too many requests/i.test(msg) && attempt < 1) {
          const m = msg.match(/try again in ([\d.]+)\s*s/i);
          const wait = Math.min(30000, m ? Math.ceil(Number(m[1]) * 1000) + 500 : 15000);
          console.log(`[llm] Groq 비전 한도 — ${Math.round(wait / 1000)}초 후 재시도`);
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }
        console.log("[llm] Groq 비전 실패:", msg.slice(0, 80));
        return null;
      }
      // thinking 모델은 <think>…</think>를 본문에 섞어 내기도 한다 — 걷어내고 답만. 닫히지 않았으면 잘린 것
      let t = String(j?.choices?.[0]?.message?.content ?? "").replace(/<think>[\s\S]*?<\/think>/g, "");
      if (/<think>/i.test(t)) { console.log("[llm] Groq 비전 응답이 사고 중에 잘림"); return null; }
      t = t.trim();
      if (t) console.log(`[llm] Groq 비전 폴백 사용 (${model}): ${t.slice(0, 40).replace(/\s+/g, " ")}`);
      return t || null;
    } catch (e) {
      console.log("[llm] Groq 비전 오류:", String(e).slice(0, 80));
      return null;
    }
  }
  return null;
}

/** 텍스트 생성 폴백 체인: Gemini → Groq(무료). 모두 실패하면 null. */
async function llmGenerate(prompt, maxTokens) {
  const g = await geminiCall([{ text: prompt }], maxTokens);
  if (g) return g;
  if (process.env.GROQ_KEY) {
    try {
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.GROQ_KEY}` },
        body: JSON.stringify({
          model: await resolveGroqTextModel(),
          messages: [{ role: "user", content: prompt }],
          max_tokens: maxTokens,
          temperature: 0.8,
        }),
        signal: AbortSignal.timeout(40000),
      });
      const j = await res.json();
      const t = (j?.choices?.[0]?.message?.content ?? "").trim();
      if (t) return t;
      if (j?.error) console.log("[llm] Groq 실패:", String(j.error.message ?? "").slice(0, 80));
    } catch (e) {
      console.log("[llm] Groq 오류:", String(e).slice(0, 80));
    }
  }
  return null;
}

/**
 * 대표메뉴·소개글 보강.
 * 왜: 이름과 지역만 주고 문구를 만들게 하면 "OO시의 깊은 진국 순대국"처럼
 * 어느 집에나 붙는 말이 나온다. 실제 근거(대표메뉴·소개)가 있어야 구체적인 설명이 된다.
 */
async function enrichPlaces(places) {
  const clean = (v) =>
    String(v ?? "").replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/gi, " ").replace(/\s+/g, " ").trim();
  for (const p of places) {
    if (/^(busan|jeju|seoul|gyeongju|wonju)-/.test(p.contentId)) continue; // 지자체·서울DB 항목은 TourAPI 콘텐츠가 아니라 상세조회 불가
    try {
      const it = (await tourCall("detailIntro2", { contentId: p.contentId, contentTypeId: "39" }))[0] ?? {};
      const menu = (clean(it.firstmenu) || clean(it.treatmenu))
        .split(/\s*,\s*/).map((x) => x.trim()).filter(Boolean).slice(0, 4).join(", ");
      if (menu) p.menu = menu.slice(0, 60);
    } catch { /* 메뉴 없어도 진행 */ }
    try {
      const ov = clean((await tourCall("detailCommon2", { contentId: p.contentId }))[0]?.overview);
      if (ov) p.overview = ov;
    } catch { /* 소개 없어도 진행 */ }
  }
  console.log(`정보 보강: 메뉴 ${places.filter((p) => p.menu).length}곳 / 소개 ${places.filter((p) => p.overview).length}곳`);
}

/** 한줄평(표지용) + 상세 설명(슬라이드용) 생성 — 모든 AI 실패 시 null(모음집 발행 스킵) */
async function makeDescriptions(theme, places) {
  const prompt = `인스타 맛집 카드뉴스 문구를 만들어줘. 주제: "${theme.mode === "area" ? theme.keyword + " 일대 맛집 모음 (음식 종류는 제각각 — 각 집의 대표 메뉴를 앞세워)" : theme.keyword + " 맛집 모음"}"

식당 정보:
${places
  .map((p, i) => {
    const b = [`${i + 1}. ${p.name} (${p.region})`];
    if (p.menu) b.push(`   대표메뉴: ${p.menu}`);
    if (p.goodPrice?.price) b.push(`   착한가격업소(정부 지정): ${p.goodPrice.menu} ${p.goodPrice.price.toLocaleString()}원`);
    if (p.overview) b.push(`   소개: ${p.overview.slice(0, 240)}`);
    return b.join("\n");
  })
  .join("\n")}

각 식당마다 두 가지를 만들어:
- s: 표지 카드용. 짧은 명사구 2~3개를 배열로. 각 항목 10~18자 (18자 초과 금지 — 카드에서 잘린다).
     ⚠️ 반드시 명사로 끝낼 것. "~해요/~예요/~있어요" 같은 서술형 종결 금지.
     "~끓여낸/~담긴/~이어온" 같은 관형형 종결도 금지(문장이 잘린 것처럼 보인다).
     조사 종결("~육수의", "~공간과")·동사 어간 종결("~고르", "~찾")도 금지 —
     모든 항목의 마지막 단어는 완결된 명사여야 한다 (국밥/백반/구이/육수/노포 등).
     항목마다 다른 정보를 담아: ① 대표메뉴와 재료·조리 특징 ② 곁들임·구성 ③ 역사·위치·분위기 중 하나.
     예: ["12시간 고아낸 사골육수 순대국밥", "손으로 채운 수제 순대와 머리고기", "1987년부터 이어온 시장 노포"]
- d: 캡션용 상세 설명 (70~90자, 존댓말 해요체 2~3문장). 캡션은 줄글이라 서술형으로 쓴다.
     s보다 더 자세히 — 무엇을 파는 집인지, 어떤 점이 특별한지, 알아두면 좋은 점.

금지(어느 집에나 붙는 말): "고양시의 깊은 진국 순대국", "현지에서 오래 사랑받는 맛집", "정성이 담긴 한 그릇"

규칙: 상호명 반복 금지, 없는 사실 지어내기 금지(정보가 부족하면 그 음식 자체의 특징으로), 식당마다 서로 다른 표현 사용.
JSON 배열만 출력: [{"s":["...","..."],"d":"..."}, ...] (${places.length}개)`;
  const text = await llmGenerate(prompt, 3600);
  if (!text) return null;
  try {
    const m = text.match(/\[[\s\S]*\]/);
    if (!m) return null;
    const arr = JSON.parse(m[0]);
    if (!Array.isArray(arr) || !arr.some((x) => x?.s && x?.d)) return null;

    // 표지 문구는 개조식(명사 종결) 항목 목록. 문자열로 오면 문장부호로 쪼개 항목화한다.
    const trimPhrase = (v) => {
      let t = String(v ?? "").trim().replace(/[.·]+$/, "");
      if ([...t].length > 20) t = [...t].slice(0, 20).join("").replace(/\s*\S*$/, "");
      // 잘린 자리(또는 원문)에 조사가 남으면 미완성 문장처럼 보인다 — 꼬리 조사 제거
      // (실측 감사: "정성스러운 육수의", "넓은 주차 공간과", "삶아내는 쫄깃")
      return t.replace(/(의|과|와|은|는|이|가|을|를|에|로|도)$/, "").trim();
    };
    const toLines = (v) => {
      const raw = Array.isArray(v) ? v : String(v ?? "").split(/(?<=[.!?])\s+|\s*[·|]\s*/);
      return raw.map(trimPhrase).filter(Boolean).slice(0, 3);
    };
    // 캡션은 줄글이라 상한에서 자를 때 마지막 완성 문장까지만 남긴다
    const trimSentence = (v, max) => {
      const t = String(v ?? "").trim();
      const ch = [...t];
      if (ch.length <= max) return t;
      const cut = ch.slice(0, max).join("");
      const i = Math.max(cut.lastIndexOf("."), cut.lastIndexOf("!"), cut.lastIndexOf("?"));
      return i > max * 0.5 ? cut.slice(0, i + 1) : cut.replace(/\s*\S*$/, "") + "…";
    };
    const fbLines = [theme.mode === "area" ? "동네 사람들이 오래 찾은 집" : `${theme.keyword} 한 가지로 이어온 노포`, "현지에서 오래 사랑받아온 집"];
    const fbDetail = `${theme.keyword} 하나로 오랜 시간 사랑받아온, 믿고 찾아갈 수 있는 곳이에요.`;
    return places.map((_, i) => {
      const lines = toLines(arr[i]?.s);
      return {
        lines: lines.length ? lines : fbLines,
        short: (lines.length ? lines : fbLines).join(", "),
        detail: trimSentence(arr[i]?.d ?? fbDetail, 140), // 캡션은 길이 제약이 없어 문장이 끊기지 않게 넉넉히
      };
    });
  } catch {
    return null;
  }
}

/**
 * 릴스용 표지(1080x1920): 원본 인포그래픽 그리드 스타일 유지(사진+번호+이름+지역칩+한줄소개),
 * 배경만 음식 사진(어둡고 따뜻한 오버레이)으로 먹음직스럽게. 릴스 규격에 딱 맞음.
 */
async function composeReelCover(theme, places, dark = false, bgUrl = null) {
  // dark=true면 흰 카드 대신 반투명 다크 카드. 어느 쪽이 유입이 좋은지 비교하려고
  // 두 배색을 같은 레이아웃으로 유지한다(레이아웃 차이가 섞이면 비교가 안 된다).
  const PAL = dark
    ? { card: "#170d09", cardOp: 0.84, stroke: "#ffffff", strokeOp: 0.14,
        name: "#ffffff", desc: "#ded2cb", accent: "#ff4b2b",
        scrim: 0.7, top: "#ffb59a", subBadge: true, sub: "#ffffff", footer: "#c9b8b0" }
    : { card: "#ffffff", cardOp: 0.97, stroke: "#f0dcd6", strokeOp: 1,
        name: "#b81414", desc: "#3a2a24", accent: "#d92121",
        scrim: 0.62, top: "#ffcdb3", subBadge: false, sub: "#ffd54a", footer: "#e0cfc4" };
  const sharp = (await import("sharp")).default;
  const W = 1080, H = 1920;

  // 레이아웃 방침 (2026-08 두 차례 실측의 절충):
  //  1) 피드·프로필은 4:5로 가운데를 잘라 보여준다 → 제목은 반드시 y=285 아래에.
  //     (8/19 국밥: 위쪽에 둔 200px 제목이 피드에서 통째로 잘림)
  //  2) 그렇다고 모든 내용을 가운데 4:5 안에 가두면 확대(9:16)했을 때 위아래가
  //     흐린 배경뿐이라 허전하다. (8/21 돈까스: "확대하면 오히려 더 안좋다" 피드백.
  //     구형 풀블리드였던 짬뽕 8대 맛집이 확대 시 가득 차 보였고 조회수도 최고였다)
  //  → 제목만 안전영역에 두고, 카드 그리드는 화면 맨 아래까지, 위쪽 잘림 영역은
  //    음식 사진 모자이크 띠로 채운다. 피드에서는 마지막 줄이 살짝 잘려 보이는데
  //    "아래 더 있다"는 신호라 오히려 클릭 유도가 된다.
  const CT = 285; // 4:5 피드 크롭의 위쪽 경계
  const BAND_H = 272; // 상단 모자이크 띠 (피드에선 안 보이고 확대 시 노출)
  const HEADER_END = 560; // 제목 블록 끝 (BAND_H..560 사이가 제목 자리)
  const GRID_BOT = 1856; // 카드 그리드 끝 — 그 아래 얇은 푸터
  const rows = Math.ceil(places.length / 2);
  const CELL_W = 540, CELL_H = Math.floor((GRID_BOT - HEADER_END) / rows);
  const IN = 10;
  const CARD_W = CELL_W - 16, CARD_H = CELL_H - 12;
  const PH_W = CARD_W - IN * 2;
  const PH_H = Math.round(CELL_H * 0.55);

  // 배경: 음식 사진 풀블리드 + 오버레이. 블러는 원본에 박힌 타 블로그 워터마크를
  // 뭉개기 위한 것(배경은 장식일 뿐이라 카드가 도드라지는 효과도 있다).
  const bgPlace = places.find((p) => p.foodPicked) ?? places[0];
  let bgBuf = await fetchPhoto(bgUrl ?? bgPlace.imageUrl, bgPlace.name);
  if (!bgBuf && bgUrl) bgBuf = await fetchPhoto(bgPlace.imageUrl, bgPlace.name); // 포토코리아 실패 → 식당 사진
  if (!bgBuf) throw new Error("릴스 배경 사진 실패");
  const bgPhoto = await sharp(bgBuf)
    .resize(W, H, { fit: "cover" })
    .blur(dark ? 18 : 14)
    .modulate({ saturation: dark ? 1.0 : 1.12, brightness: dark ? 0.92 : 1 })
    .jpeg({ quality: 86 })
    .toBuffer();

  const cellPos = (i) => {
    const lastOdd = places.length % 2 === 1 && i === places.length - 1;
    const col = i % 2, row = Math.floor(i / 2);
    return { x: lastOdd ? (W - CELL_W) / 2 : col * CELL_W, y: HEADER_END + row * CELL_H };
  };

  // 사진은 한 곳당 한 번만 받아 카드와 상단 모자이크에 같이 쓴다
  const photoBufs = [];
  for (const p of places) {
    photoBufs.push(await fetchPhoto(p.imageUrl, p.name));
  }
  // 무사진 칸 디자인 확인용 — ROUNDUP_NOPHOTO="2,5" (1-based)면 그 칸의 사진을 버린다.
  // 시안 렌더 전용이고 실발행에서는 이 값을 주지 않는다.
  for (const i of String(process.env.ROUNDUP_NOPHOTO || "").split(",").map((x) => Number(x.trim()) - 1)) {
    if (i >= 0 && i < photoBufs.length) photoBufs[i] = null;
  }

  /**
   * 사진이 없는 칸에 넣을 패널. 이 봇의 사진 출처는 공공누리 등 합법 소스뿐이라
   * 발굴은 됐는데 사진이 없는 식당이 생긴다(Overture 등). 그때 생성 이미지를 넣으면
   * '이 가게 음식이 이렇게 생겼다'는 없는 사실을 만드는 셈이라(lib/pexels.ts 사칭 방지
   * 원칙과 같은 이유) 대신 실제로 가진 데이터 — 대표메뉴와 후기·조회수 — 를 보여준다.
   * 아무 주장도 하지 않으므로 사진이 없다는 사과 문구도 넣지 않는다.
   */
  async function noPhotoPanel(p) {
    // ⚠️ 아래 54px은 기존 칩(지역·후기/YT·백년가게)이 사진 위에 얹히는 자리다 — 비워 둘 것.
    const CHIP_ZONE = 54;
    const menu = String(p.menu || "").split(/[,·/]/)[0].trim().slice(0, 14);
    const label = menu ? "대표메뉴" : "";
    const raw = menu || coverName(p.name);
    // 한 줄에 담기지 않으면 두 줄로 나눈다. 예전엔 최소 48px로 고정해서 11자만 넘어도
    // 패널 밖으로 잘렸다(검토 실측) — 대표메뉴가 없어 상호명으로 폴백할 때 실제로 났다.
    const MAXW = PH_W - 36;
    const fit = (t, size) => [...t].length * size * 0.98 <= MAXW;
    let lines = [raw], fs2 = Math.min(84, Math.floor(MAXW / Math.max(1, [...raw].length * 0.98)));
    if (fs2 < 44) {
      lines = wrapLines(raw, Math.ceil([...raw].length / 2), 2);
      const longest = Math.max(...lines.map((l) => [...l].length), 1);
      fs2 = Math.min(60, Math.floor(MAXW / (longest * 0.98)));
    }
    fs2 = Math.max(26, fs2); // 그래도 안 맞으면 더 줄인다 — 잘리는 것보다 낫다
    while (lines.some((l) => !fit(l, fs2)) && fs2 > 26) fs2 -= 2;
    const midY = (PH_H - CHIP_ZONE) / 2 - (lines.length - 1) * fs2 * 0.42;
    const baseY = midY + fs2 * 0.36; // 첫 줄 베이스라인
    const svg = `<svg width="${PH_W}" height="${PH_H}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="np" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="${dark ? "#2a1a12" : "#fff4ec"}"/>
          <stop offset="100%" stop-color="${dark ? "#1a0f0a" : "#ffe2d2"}"/>
        </linearGradient>
        <pattern id="dots" width="20" height="20" patternUnits="userSpaceOnUse">
          <circle cx="3" cy="3" r="1.5" fill="${PAL.accent}" fill-opacity="0.14"/>
        </pattern>
      </defs>
      <rect width="${PH_W}" height="${PH_H}" rx="14" fill="url(#np)"/>
      <rect width="${PH_W}" height="${PH_H}" rx="14" fill="url(#dots)"/>
      <rect x="1" y="1" width="${PH_W - 2}" height="${PH_H - 2}" rx="13" fill="none" stroke="${PAL.accent}" stroke-opacity="0.3" stroke-width="2"/>
      ${label ? `<text x="${PH_W / 2}" y="${midY - fs2 * 0.58}" font-family="${FONT}" font-size="21" font-weight="700" letter-spacing="2" fill="${dark ? "#c9b8b0" : "#a3796a"}" text-anchor="middle">${label}</text>` : ""}
      ${lines.map((ln, k) => `<text x="${PH_W / 2}" y="${baseY + k * fs2 * 1.12}" font-family="${TFONT}" font-size="${fs2}" font-weight="900" fill="${dark ? "#ffd9c9" : PAL.name}" text-anchor="middle">${esc(ln)}</text>`).join("")}
      <rect x="${PH_W / 2 - 46}" y="${baseY + (lines.length - 1) * fs2 * 1.12 + 18}" width="92" height="5" rx="2.5" fill="${PAL.accent}" fill-opacity="0.55"/>
    </svg>`;
    return sharp(Buffer.from(svg)).png().toBuffer();
  }

  const mask = Buffer.from(
    `<svg width="${PH_W}" height="${PH_H}"><rect x="0" y="0" width="${PH_W}" height="${PH_H}" rx="14" ry="14" fill="#fff"/></svg>`
  );
  const photoLayers = [];
  for (let i = 0; i < places.length; i++) {
    const { x: px, y: py } = cellPos(i);
    if (!photoBufs[i]) {
      // 빈칸으로 두면 카드가 깨져 보인다 — 가진 데이터로 채운다
      try {
        photoLayers.push({ input: await noPhotoPanel(places[i]), left: px + 8 + IN, top: py + 6 + IN });
      } catch (e) {
        console.error(`무사진 패널 실패(빈칸): ${places[i].name}`, String(e).slice(0, 80));
      }
      continue;
    }
    try {
      const { x, y } = cellPos(i);
      const rounded = await sharp(photoBufs[i])
        .resize(PH_W, PH_H, { fit: "cover", position: "attention" })
        .ensureAlpha()
        .composite([{ input: mask, blend: "dest-in" }])
        .png()
        .toBuffer();
      photoLayers.push({ input: rounded, left: x + 8 + IN, top: y + 6 + IN });
    } catch { /* skip */ }
  }

  // 상단 모자이크 띠 — 확대했을 때만 보이는 영역이므로 정보는 없고 분위기만 채운다
  const bandLayers = [];
  const bandOk = photoBufs.filter(Boolean);
  if (bandOk.length) {
    const TILE_W = Math.ceil(W / bandOk.length);
    for (let i = 0; i < bandOk.length; i++) {
      try {
        bandLayers.push({
          input: await sharp(bandOk[i])
            .resize(TILE_W, BAND_H, { fit: "cover", position: "attention" })
            .modulate({ brightness: 0.72, saturation: 1.05 })
            .jpeg({ quality: 84 })
            .toBuffer(),
          left: i * TILE_W,
          top: 0,
        });
      } catch { /* skip */ }
    }
  }

  let bgCells = "", textCells = "";
  for (let i = 0; i < places.length; i++) {
    const p = places[i];
    const { x, y } = cellPos(i);
    const CX = x + 8, CY = y + 6;
    const base = CY + IN + PH_H; // 사진 아래 기준선
    const nm = coverName(p.name);
    const ns = nm.length <= 8 ? 37 : nm.length <= 10 ? 32 : 28;
    // 글자수로 잘라 쓰면 단어가 끊긴다 → 어절 단위 줄바꿈. 개조식 항목이 있으면 그대로.
    const dl = (p.descLines?.length ? p.descLines : wrapLines(p.desc ?? "", 24, 3)).slice(0, 3);
    const chipW = p.region.length * 19 + 44;
    bgCells += `<rect x="${CX}" y="${CY}" width="${CARD_W}" height="${CARD_H}" rx="22" fill="${PAL.card}" fill-opacity="${PAL.cardOp}" stroke="${PAL.stroke}" stroke-opacity="${PAL.strokeOp}" stroke-width="2"/>`;
    textCells += `
    <g>
      <rect x="${CX + IN + 10}" y="${CY + IN + 10}" width="52" height="52" rx="14" fill="${PAL.accent}"/>
      <text x="${CX + IN + 36}" y="${CY + IN + 47}" font-family="${FONT}" font-size="31" font-weight="800" fill="#fff" text-anchor="middle">${i + 1}</text>
      <rect x="${CX + IN + 10}" y="${base - 44}" width="${chipW}" height="34" rx="17" fill="#000000" fill-opacity="0.6"/>
      <text x="${CX + IN + 10 + chipW / 2}" y="${base - 20}" font-family="${FONT}" font-size="19" font-weight="700" fill="#ffffff" text-anchor="middle">📍 ${esc(p.region)}</text>
      ${p.buzz || p.ytViews ? (() => {
        const t = [p.buzz ? `후기 ${fmtK(p.buzz)}` : "", p.ytViews ? `YT ${fmtK(p.ytViews)}` : ""].filter(Boolean).join("·");
        const w = t.length * 12 + 34;
        return `<rect x="${CX + CARD_W - IN - w - 2}" y="${base - 44}" width="${w}" height="34" rx="17" fill="#000000" fill-opacity="0.62"/>
      <text x="${CX + CARD_W - IN - w / 2 - 2}" y="${base - 20}" font-family="${FONT}" font-size="18" font-weight="700" fill="#ffe9a8" text-anchor="middle">🔎 ${esc(t)}</text>`;
      })() : ""}
      ${p.hundred ? `<rect x="${CX + IN + 18 + chipW}" y="${base - 44}" width="104" height="34" rx="17" fill="#ffd54a" fill-opacity="0.92"/>
      <text x="${CX + IN + 70 + chipW}" y="${base - 20}" font-family="${FONT}" font-size="19" font-weight="800" fill="#6b4a06" text-anchor="middle">백년가게</text>` : p.goodPrice ? `<rect x="${CX + IN + 18 + chipW}" y="${base - 44}" width="104" height="34" rx="17" fill="#c8f3d4" fill-opacity="0.95"/>
      <text x="${CX + IN + 70 + chipW}" y="${base - 20}" font-family="${FONT}" font-size="19" font-weight="800" fill="#0d6b33" text-anchor="middle">착한가격</text>` : ""}
      <text x="${CX + IN + 2}" y="${base + 44}" font-family="${TFONT}" font-size="${ns}" font-weight="800" fill="${PAL.name}">${esc(nm)}</text>
      ${dl.map((ln, k) => `<circle cx="${CX + IN + 10}" cy="${base + 76 + k * 31}" r="4.5" fill="${PAL.accent}"/><text x="${CX + IN + 24}" y="${base + 83 + k * 31}" font-family="${FONT}" font-size="23" fill="${PAL.desc}">${esc(ln)}</text>`).join("")}
    </g>`;
  }

  // 제목: 4:5로 잘려도 살아남는 위치(CT 아래)에, 모자이크 띠와 그리드 사이
  const tp = theme.coverParts ?? {
    top: "", main: theme.food || theme.keyword, sub: `${places.length}대 ${theme.suffix || "맛집"}`,
  };
  const mainLen = Math.max(1, [...tp.main].length);
  const ms = Math.min(116, Math.floor(850 / mainLen));
  const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="hd" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#140803" stop-opacity="0.88"/>
        <stop offset="100%" stop-color="#140803" stop-opacity="0.5"/>
      </linearGradient>
      <linearGradient id="bandFade" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#140803" stop-opacity="0.25"/>
        <stop offset="100%" stop-color="#140803" stop-opacity="0.85"/>
      </linearGradient>
    </defs>
    <rect x="0" y="${BAND_H}" width="${W}" height="${H - BAND_H}" fill="#1a0d08" fill-opacity="${PAL.scrim}"/>
    <rect x="0" y="0" width="${W}" height="${BAND_H}" fill="url(#bandFade)"/>
    ${dark ? "" : `<rect x="0" y="${BAND_H}" width="${W}" height="${HEADER_END - BAND_H}" fill="url(#hd)"/>`}
    <text x="${W / 2}" y="${CT + 44}" font-family="${TFONT}" font-size="30" font-weight="700" fill="${PAL.top}" text-anchor="middle">${esc(tp.top)}</text>
    <text x="${W / 2}" y="${CT + 52 + Math.round(ms * 0.86)}" font-family="${TFONT}" font-size="${ms}" font-weight="900" fill="#ffffff" text-anchor="middle" stroke="#3a0f06" stroke-width="6" paint-order="stroke">${esc(tp.main)}</text>
    ${PAL.subBadge ? `<rect x="${W / 2 - 130}" y="${HEADER_END - 60}" width="260" height="52" rx="26" fill="${PAL.accent}"/>` : ""}
    <text x="${W / 2}" y="${HEADER_END - 22}" font-family="${TFONT}" font-size="${PAL.subBadge ? 35 : 38}" font-weight="900" fill="${PAL.sub}" text-anchor="middle">${esc(tp.sub)}</text>
    ${bgCells}
    <text x="${W / 2}" y="${H - 24}" font-family="${FONT}" font-size="24" font-weight="800" fill="#ffffff" text-anchor="middle">📌 저장해두고 하나씩 정복해 보세요 · <tspan fill="${PAL.footer}" font-weight="400" font-size="20">@${HANDLE}</tspan></text>
  </svg>`;
  const textSvg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${textCells}</svg>`;

  const out = path.join(TMP, "reel-cover.jpg");
  await sharp(bgPhoto)
    .composite([
      ...bandLayers,
      { input: Buffer.from(svg), left: 0, top: 0 },
      ...photoLayers,
      { input: Buffer.from(textSvg), left: 0, top: 0 },
    ])
    .jpeg({ quality: 88 })
    .toFile(out);
  return out;
}

/**
 * A안 표지 — 대표 음식 사진 한 장을 꽉 채우고 제목만 얹는다.
 * 그리드형(기존·다크)과 달리 썸네일에서 음식이 크게 보이는 대신 6곳 정보는 안 보인다.
 * 어느 쪽이 유입에 유리한지 비교하려고 나란히 돌린다.
 */
async function composeHeroCover(theme, places, bgUrl = null, outName = "reel-cover.jpg") {
  const sharp = (await import("sharp")).default;
  const W = 1080, H = 1920;
  const CT = Math.round((H - Math.round(W * 5 / 4)) / 2); // 285 — 4:5로 잘려도 살아남는 위쪽 경계
  const CH = Math.round(W * 5 / 4); // 1350

  // 훅 컷·히어로는 사진 한 장을 1080x1920 전체로 확대해 쓴다 — 그리드 칸(약 500px)과 달리
  // 저해상도가 그대로 드러난다(원주 소스는 표본 12곳 중 7곳이 900px 미만). 후보 앞쪽에서
  // 원본이 가장 큰 사진을 골라 쓴다. 배경이 지정된 경우(포토코리아)는 그대로.
  let p = places.find((x) => x.foodPicked) ?? places[0];
  let heroBuf = bgUrl ? await fetchPhoto(bgUrl, p.name) : null;
  if (!heroBuf) {
    const cands = [...places.filter((x) => x.foodPicked), ...places].slice(0, 4);
    let bestW = 0;
    for (const c of cands) {
      if (!c?.imageUrl) continue;
      try {
        const buf = await fetchPhoto(c.imageUrl, c.name);
        if (!buf) continue;
        const w = (await sharp(buf).metadata()).width ?? 0;
        if (w > bestW) { bestW = w; heroBuf = buf; p = c; }
        if (w >= 1400) break; // 충분히 크면 더 볼 필요 없다
      } catch { /* 다음 후보 */ }
    }
    if (bestW) console.log(`  훅 배경: ${p.name} (${bestW}px)`);
  }
  if (!heroBuf) throw new Error("히어로 배경 사진 실패");
  // 그리드형과 달리 사진 자체가 주인공이라 블러를 넣지 않는다.
  // 단 원본이 작으면(원주 소스 등 500~900px) 1080x1920으로 늘리면서 깨짐이 그대로 보인다 —
  // 그때만 약한 블러로 뭉갠다. 어차피 어둡게 깔고 큰 글자를 얹는 화면이라 위화감이 없다.
  const heroW = (await sharp(heroBuf).metadata()).width ?? 0;
  let heroPipe = sharp(heroBuf)
    .resize(W, H, { fit: "cover", position: "attention" })
    .modulate({ saturation: 1.14, brightness: 1.02 });
  if (heroW && heroW < 1000) heroPipe = heroPipe.blur(1 + (1000 - heroW) / 220);
  const bgPhoto = await heroPipe.jpeg({ quality: 90 }).toBuffer();

  const tp = theme.coverParts ?? {
    top: "", main: theme.food || theme.keyword, sub: `${places.length}대 ${theme.suffix || "맛집"}`,
  };
  const mainLen = Math.max(1, [...tp.main].length);
  const ms = Math.min(215, Math.floor(980 / mainLen));

  // 제목 덩어리를 4:5 화면 한가운데에 둔다 (윗줄 + 음식명 + 배지)
  const BLOCK = 46 + ms + 20 + 84;
  const bs = CT + Math.round((CH - BLOCK) / 2);
  // "동·서" 같은 단독 구 이름은 어느 도시인지 모호하다 — 전체 지역명("인천 동")으로
  const regions = [...new Set(places.map((x) => x.region))].join(" · ");

  const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bt" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#120703" stop-opacity="0"/>
        <stop offset="100%" stop-color="#120703" stop-opacity="0.92"/>
      </linearGradient>
    </defs>
    <rect x="0" y="0" width="${W}" height="${H}" fill="#120703" fill-opacity="0.42"/>
    <rect x="0" y="${CT + Math.round(CH * 0.55)}" width="${W}" height="${H - CT - Math.round(CH * 0.55)}" fill="url(#bt)"/>
    <text x="${W / 2}" y="${bs + 40}" font-family="${FONT}" font-size="40" font-weight="700" fill="#ffcdb3" text-anchor="middle">${esc(tp.top)}</text>
    <text x="${W / 2}" y="${bs + 46 + Math.round(ms * 0.86)}" font-family="${TFONT}" font-size="${ms}" font-weight="900" fill="#ffffff" text-anchor="middle" stroke="#2a0a03" stroke-width="8" paint-order="stroke">${esc(tp.main)}</text>
    <rect x="${W / 2 - 175}" y="${bs + 66 + ms}" width="350" height="84" rx="42" fill="#d92121"/>
    <text x="${W / 2}" y="${bs + 125 + ms}" font-family="${FONT}" font-size="52" font-weight="900" fill="#ffffff" text-anchor="middle">${esc(tp.sub)}</text>
    <text x="${W / 2}" y="${CT + CH - 122}" font-family="${FONT}" font-size="31" font-weight="700" fill="#ffd9c9" text-anchor="middle">${esc(regions)}</text>
    <text x="${W / 2}" y="${CT + CH - 58}" font-family="${FONT}" font-size="36" font-weight="800" fill="#ffffff" text-anchor="middle">📌 저장해두고 하나씩 정복하기</text>
    <text x="${W / 2}" y="${CT + CH - 14}" font-family="${FONT}" font-size="22" fill="#e0cfc4" text-anchor="middle">@${HANDLE}</text>
  </svg>`;

  // ⚠️ 기본 파일명이 composeReelCover와 같다 — 훅 컷처럼 그리드 표지와 함께 쓸 때는
  //    반드시 다른 outName을 넘길 것(안 그러면 표지가 덮어써진다).
  const out = path.join(TMP, outName);
  await sharp(bgPhoto)
    .composite([{ input: Buffer.from(svg), left: 0, top: 0 }])
    .jpeg({ quality: 90 })
    .toFile(out);
  return out;
}

/**
 * 표지 카드에 넣을 상호명.
 * 괄호 표기와 지점명은 칸을 다 잡아먹고 잘리므로 뺀다. 다만 "3.3 국밥전문점"의
 * "국밥전문점"까지 지워져 "3.3"만 남은 적이 있어(2026-08-19), 지점으로 볼 수 있는
 * 짧은 마지막 어절만 지우고 업종어는 지키도록 한다.
 */
/** 지점명인가 — "(신촌점)"·"강남점"·"본점" 같은 꼬리표가 붙은 상호 */
function isBranchName(raw) {
  const s = String(raw);
  if (/\([^)]*점\)/.test(s)) return true;
  const parts = s.replace(/\([^)]*\)/g, "").trim().split(/\s+/);
  const last = parts[parts.length - 1] ?? "";
  return parts.length > 1 && /점$/.test(last) && last.length <= 4;
}

/**
 * 브랜드 키 — 같은 브랜드의 지점들을 하나로 묶는다 (벽제갈비 / 벽제갈비(신촌점) / 벽제갈비 본점 → 동일).
 * 한 편에 같은 브랜드 지점이 2곳 들어가던 실측(2026-09-07 홍대 DRY) 대응. 순수 상호 비교라
 * "3.3 국밥전문점"처럼 업종어가 붙은 이름은 coverName과 같은 예외로 보존한다.
 */
function brandOf(raw) {
  const NOT_BRANCH = ["전문점", "음식점", "분식점", "할인점", "가맹점", "체인점"];
  const parts = String(raw).replace(/\([^)]*\)/g, "").replace(/\s+/g, " ").trim().split(" ");
  const last = parts[parts.length - 1] ?? "";
  if (parts.length > 1 && /점$/.test(last) && last.length <= 4 && !NOT_BRANCH.includes(last)) parts.pop();
  return parts.join("").replace(/(본점|본관|총본점|직영점)$/, "").toLowerCase();
}

function coverName(raw) {
  const NOT_BRANCH = ["전문점", "음식점", "분식점", "할인점", "가맹점", "체인점"];
  const parts = String(raw).replace(/\([^)]*\)/g, "").replace(/\s+/g, " ").trim().split(" ");
  const last = parts[parts.length - 1] ?? "";
  if (parts.length > 1 && /점$/.test(last) && last.length <= 4 && !NOT_BRANCH.includes(last)) parts.pop();
  const name = parts.join(" ") || String(raw);
  return name.length > 13 ? name.slice(0, 12) + "…" : name;
}

/**
 * 캐러셀용 식당 상세 카드 (1080x1350, 4:5).
 * 저장형 포맷 실험(2026-09): 저장이 이 계정의 승부 지표인데 캐러셀은 릴스보다
 * 저장·재열람에 강하고 배포 풀도 별개다. classic 그리드의 검증된 문법
 * (흰 카드·빨간 포인트·개조식 불릿)을 카드 한 장 규격으로 옮긴 것.
 */
async function composeCarouselCard(sharp, place, idx) {
  const W = 1080, H = 1350, PH_H = 780;
  const cardBuf = await fetchPhoto(place.imageUrl, place.name);
  if (!cardBuf) throw new Error("카드 사진 실패");
  const photo = await sharp(cardBuf)
    .resize(W, PH_H, { fit: "cover", position: "attention" })
    .modulate({ saturation: 1.08 })
    .jpeg({ quality: 88 })
    .toBuffer();

  const nm = coverName(place.name);
  const ns = nm.length <= 8 ? 62 : nm.length <= 11 ? 52 : 42;
  const dl = (place.descLines?.length ? place.descLines : wrapLines(place.desc ?? "", 24, 3)).slice(0, 3);
  const chipW = place.region.length * 26 + 60;
  const svg = Buffer.from(
    `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="${PH_H}" width="${W}" height="${H - PH_H}" fill="#ffffff"/>
      <rect x="40" y="${PH_H - 44}" width="88" height="88" rx="22" fill="#d92121"/>
      <text x="84" y="${PH_H + 18}" font-family="${FONT}" font-size="52" font-weight="800" fill="#fff" text-anchor="middle">${idx}</text>
      <text x="160" y="${PH_H + 84}" font-family="${TFONT}" font-size="${ns}" font-weight="800" fill="#b81414">${esc(nm)}</text>
      <rect x="160" y="${PH_H + 112}" width="${chipW}" height="52" rx="26" fill="#f6ede7"/>
      <text x="${160 + chipW / 2}" y="${PH_H + 148}" font-family="${FONT}" font-size="30" font-weight="700" fill="#8a5a44" text-anchor="middle">📍 ${esc(place.region)}</text>
      ${place.hundred ? `<rect x="${172 + chipW}" y="${PH_H + 112}" width="160" height="52" rx="26" fill="#fff3d6" stroke="#e8c66a" stroke-width="2"/>
      <text x="${252 + chipW}" y="${PH_H + 148}" font-family="${FONT}" font-size="28" font-weight="800" fill="#9a7419" text-anchor="middle">백년가게</text>` : ""}
      ${dl.map((ln, k) => `<circle cx="56" cy="${PH_H + 216 + k * 62}" r="8" fill="#d92121"/><text x="84" y="${PH_H + 228 + k * 62}" font-family="${FONT}" font-size="38" fill="#3a2a24">${esc(ln)}</text>`).join("")}
      <text x="${W - 40}" y="${H - 32}" font-family="${FONT}" font-size="26" fill="#b8a89e" text-anchor="end">@${HANDLE}</text>
    </svg>`
  );
  return sharp({ create: { width: W, height: H, channels: 3, background: "#ffffff" } })
    .composite([{ input: photo, left: 0, top: 0 }, { input: svg, left: 0, top: 0 }])
    .jpeg({ quality: 90 })
    .toBuffer();
}

/**
 * 자극형 제목 — 표지에서 음식 이름(main)만 초대형으로 뽑아 쓰기 위해 3조각으로 나눠 준다.
 * text는 캡션·기록용 전체 문장.
 */
/**
 * 훅 컷(첫 3초) 전용 문구 — 반문형.
 * 지금까지 훅 컷과 그리드 표지가 같은 제목을 써서 3초를 낭비했다(같은 글자를 두 번 보여줌).
 * 실측(2026-09-09): 물음표 종결 2.02x · 통념파괴형 3.03x로 상위 공식이고,
 * 사용자 확정 훅 규칙에 "반문"이 이미 허용돼 있어 규칙 변경 없이 비중만 올린다.
 * 큰 글자를 살리려고 main(음식·지역명)은 그대로 두고 sub만 반문으로 바꾼다
 * (main에 문장을 넣으면 980/글자수 계산 때문에 타이포가 작아진다).
 */
function buildHookTitle(theme, n) {
  const main = theme.mode === "area" ? theme.keyword : theme.food || theme.keyword;
  const subs =
    theme.mode === "area"
      ? ["여기가 끝?", "진짜 여기야?", "이 동네 실화?", "여기 가봤어?"]
      : ["성지가 여기라고?", "여기가 원탑?", "이게 실화?", "진짜 여기야?"];
  const sub = subs[Math.floor(Math.random() * subs.length)];
  return { text: `${main} ${sub}`, top: "", main, sub };
}

function buildPunchyTitle(theme, n) {
  if (theme.mode === "area") {
    // 지역편: 대형 타이포 = 동네 이름 ("성수동" / "강릉"), 수식어는 무지역형만.
    // 2026-09-09 유튜브 실측(국내 식당 464건, 중앙 7.1만 기준):
    //   "줄서는·현지인·웨이팅"류 117건 0.45x — 가장 흔하고 가장 안 먹힌다 → 제거
    //   "TOP N" 40건 0.56x < "N대 맛집" 쪽 → TOP N 제거하고 N대 맛집으로 통일
    const tops = [`죽기 전에 꼭 먹어야 할`, `아는 사람만 간다는`, `놓치면 후회하는`, `요즘 난리 난`];
    const top = tops[Math.floor(Math.random() * tops.length)];
    const sub = `${n}대 맛집`;
    // 캡션·검색 노출용 text는 지역명을 뒤로 뺀다 — 같은 실측에서 지역명이 앞 6글자 안이면
    // 0.50x, 뒤쪽이면 1.96x였다. 표지 시각(초대형 지역명)은 지역편 정체성이라 그대로 둔다.
    return { text: `${top} ${sub} · ${theme.keyword}`, top, main: theme.keyword, sub };
  }
  const r = theme.region || "전국";
  const f = theme.food || theme.keyword;
  const sfx = theme.suffix || "맛집";
  // 상위 쇼츠 벤치마크(2026-08): "경악·반전·극단" 수식어가 조회수 상위 공식 —
  // 거짓 없는 선에서 극단형을 몇 개 추가해 순환
  const tops = [
    `${r}에서 제일 맛있는`,
    `죽기 전에 꼭 먹어야 할`,
    `아는 사람만 간다는`,
    `${r} 사람들이 인정한`,
    `놓치면 후회하는`,
    `요즘 난리 난`,
  ]; // "줄서는·웨이팅·현지인"류는 실측 0.45x(가장 흔하고 가장 약함)라 뺐다
  // 지역 시리즈(전국이 아닌 테마)는 지역이 정체성 — 대형 타이포에 지역 포함
  // ("영남 순대국"). 이때 수식어는 지역 중복을 피해 무지역형만 쓴다.
  const regional = r !== "전국";
  const pool = regional ? tops.filter((t) => !t.includes(r)) : tops;
  const top = pool[Math.floor(Math.random() * pool.length)];
  const main = regional ? `${r} ${f}` : f;
  // "N선"은 사용자 피드백으로 제외 — 역대 최고 성과작("전국 짬뽕 8대 맛집")의
  // "N대 맛집"을 기본으로 하고 "TOP N"을 섞는다.
  // TOP N은 실측 0.56x(N대 맛집 대비 약함)라 뺐다 — 사용자 규칙상 둘 다 허용된 형태 중 선택
  const subs = [`${n}대 ${sfx}`];
  const sub = subs[Math.floor(Math.random() * subs.length)];
  return { text: `${top} ${main} ${sub}`, top, main, sub };
}

// ===== 카운트다운 릴스용 카드 (한 곳씩 크게 공개 → 1위 보려고 끝까지 봄) =====

const RW = 1080, RH = 1920;

/**
 * 도장깨기 체크리스트 카드 (1080x1920, 콘텐츠는 4:5 안전영역 안).
 * 저장·재열람을 유도하는 마지막 카드 — "저장할 이유"를 체크박스로 시각화한다.
 * (2026 트렌드: 저장·DM공유가 도달의 핵심 신호. 리스트형 저장 문화 정착)
 */
async function composeChecklistCard(sharp, theme, places) {
  const W = 1080, H = 1920, CT = 285, CH = 1350;
  const f = theme.food || theme.keyword;
  const rowH = Math.min(150, Math.floor((CH - 420) / places.length));
  const rows = places
    .map((p, i) => {
      const y = CT + 320 + i * rowH;
      const nm = coverName(p.name);
      return `
      <rect x="90" y="${y}" width="64" height="64" rx="14" fill="none" stroke="#d92121" stroke-width="5"/>
      <text x="186" y="${y + 46}" font-family="${FONT}" font-size="40" font-weight="800" fill="#2b1d18">${i + 1}. ${esc(nm)}</text>
      <text x="${W - 90}" y="${y + 44}" font-family="${FONT}" font-size="28" font-weight="700" fill="#8a5a44" text-anchor="end">${esc(p.region)}</text>`;
    })
    .join("");
  const svg = Buffer.from(
    `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${W}" height="${H}" fill="#fdf8f3"/>
      <rect x="0" y="0" width="${W}" height="${CT}" fill="#f3e8df"/>
      <rect x="0" y="${CT + CH}" width="${W}" height="${H - CT - CH}" fill="#f3e8df"/>
      <text x="${W / 2}" y="${CT + 120}" font-family="${TFONT}" font-size="76" font-weight="900" fill="#b81414" text-anchor="middle">📌 도장깨기 리스트</text>
      <text x="${W / 2}" y="${CT + 190}" font-family="${FONT}" font-size="40" font-weight="700" fill="#6b5348" text-anchor="middle">${esc(f)} 편 — 다녀온 곳을 체크하세요</text>
      <line x1="90" y1="${CT + 232}" x2="${W - 90}" y2="${CT + 232}" stroke="#e3d3c8" stroke-width="3"/>
      ${rows}
      <text x="${W / 2}" y="${CT + CH - 96}" font-family="${FONT}" font-size="36" font-weight="800" fill="#2b1d18" text-anchor="middle">저장해두고 하나씩 ✔ 도장 깨기</text>
      <text x="${W / 2}" y="${CT + CH - 40}" font-family="${FONT}" font-size="26" fill="#a08a7d" text-anchor="middle">전체 주소·지도는 캡션과 댓글 '지도'에서 · @${HANDLE}</text>
    </svg>`
  );
  const out = path.join(TMP, "checklist.jpg");
  await sharp(svg).jpeg({ quality: 90 }).toFile(out);
  return out;
}

/**
 * 페이지형 릴스 프레임: 캐러셀 카드(1080x1350)를 9:16 캔버스 가운데(y=285)에 얹고,
 * 위아래는 카드 사진을 늘려 블러·어둡게 깔아 검은 띠가 안 보이게 한다.
 */
async function composePageFrame(sharp, cardBuf, outPath) {
  const bg = await sharp(cardBuf).resize(1080, 1920, { fit: "cover" }).blur(28)
    .modulate({ brightness: 0.55, saturation: 1.1 }).jpeg({ quality: 80 }).toBuffer();
  await sharp(bg).composite([{ input: cardBuf, top: 285, left: 0 }]).jpeg({ quality: 90 }).toFile(outPath);
  return outPath;
}

/**
 * 페이지형 릴스 렌더 — 표지 정지컷 + 식당 카드 프레임들을 순서대로 이어붙이고 BGM을 얹는다.
 * stills: [{ path, sec }] 순서대로. 정지컷 → 개별 클립(같은 인코딩) → concat → 오디오 믹스.
 * ⚠️ "-t"는 출력 옵션 위치에 — 입력 사이에 두면 무한 루프 BGM과 -shortest가 만나 안 끝난다.
 */
async function renderPagesReel(stills, bgm, outMp4) {
  const ff = (args) =>
    new Promise((resolve, reject) => {
      const p = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "inherit"] });
      p.on("error", reject);
      p.on("close", (c) => (c === 0 ? resolve() : reject(new Error("ffmpeg exit " + c))));
    });
  const clips = [];
  for (let i = 0; i < stills.length; i++) {
    const c = path.join(TMP, `pg_${i}.mp4`);
    await ff(["-y", "-loop", "1", "-i", stills[i].path, "-vf", "fps=30,format=yuv420p",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-tune", "stillimage", "-t", String(stills[i].sec), c]);
    clips.push(c);
  }
  const list = path.join(TMP, "pg_list.txt");
  fs.writeFileSync(list, clips.map((c) => `file '${c.replace(/\\/g, "/")}'`).join("\n"));
  const joined = path.join(TMP, "pg_joined.mp4");
  await ff(["-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", joined]);
  const total = stills.reduce((a, x) => a + x.sec, 0);
  const audio = bgm
    ? ["-stream_loop", "-1", "-i", bgm.path]
    : ["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100"];
  // 비디오는 재인코딩하지 않는다 — 컷을 이미 crf18 -tune stillimage로 구웠고 concat도
  // 무손실이라, 여기서 다시 인코딩하면 그리드 표지 글자에 세대 손실만 얹힌다(PSNR -1.1dB 실측).
  await ff([
    "-y", "-i", joined, ...audio,
    ...(bgm
      ? ["-filter_complex", `[1:a]volume=0.35,afade=t=out:st=${(total - 0.8).toFixed(1)}:d=0.8[a]`]
      : []),
    "-map", "0:v", "-map", bgm ? "[a]" : "1:a",
    "-c:v", "copy", "-c:a", "aac",
    "-t", String(total), "-movflags", "+faststart", outMp4,
  ]);
  return total;
}

/**
 * 그리드 릴스 첫 3초에 붙일 훅 컷 — 음식 풀샷 + 제목만 크게.
 * 그리드 표지는 6칸에 정보가 빽빽해 첫 화면에서 "무슨 영상인지" 읽히기까지 시간이 걸린다.
 * 평균 시청 4.9초 실측(2026-09-07)이라 그 사이에 이미 넘어가는 사람이 많다 —
 * 큰 사진 한 장으로 3초 붙잡고 그리드로 넘겨 정보를 준다(사용자 결정 2026-09-07).
 * 실패해도 발행은 막지 않는다 — null이면 기존 표지 8초 단일컷으로 렌더한다.
 */
async function buildHookCut(theme, places, bgUrl) {
  try {
    // 표지(5초)와 다른 문구를 써야 3초가 제 몫을 한다 — 훅은 반문, 표지는 정보
    const hookTheme = { ...theme, coverParts: buildHookTitle(theme, places.length) };
    return await composeHeroCover(hookTheme, places, bgUrl, "hook-cut.jpg");
  } catch (e) {
    console.error("훅 컷 생성 실패(표지 8초 단일컷으로 진행):", String(e).slice(0, 120));
    return null;
  }
}

/** 페이지형 정지컷 목록: 표지 4초 + 식당 카드 각 2.5초 (사용자 지정) */
async function buildPageStills(sharp, reelCover, places) {
  const stills = [{ path: reelCover, sec: 4 }];
  for (let i = 0; i < places.length; i++) {
    try {
      const card = await composeCarouselCard(sharp, places[i], i + 1);
      stills.push({ path: await composePageFrame(sharp, card, path.join(TMP, `pg_frame_${i + 1}.jpg`)), sec: 2.5 });
    } catch (e) {
      console.error(`페이지 카드 ${i + 1} 실패(제외):`, String(e).slice(0, 80));
    }
  }
  if (stills.length < 5) throw new Error("페이지형 카드 부족"); // 표지 + 최소 4장
  return stills;
}

/** 수치 축약 — 2796→2.8천, 292000→29만 (데이터 배지용) */
function fmtK(n) {
  n = Number(n) || 0;
  if (n >= 100000000) return (n / 100000000).toFixed(1).replace(/.0$/, "") + "억";
  if (n >= 10000) return (n / 10000).toFixed(1).replace(/.0$/, "") + "만";
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/.0$/, "") + "천";
  return String(n);
}

/** 텍스트를 지정 글자수로 줄바꿈 */
function wrapLines(text, per, maxLines) {
  const words = String(text ?? "").split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > per && cur) { lines.push(cur.trim()); cur = w; }
    else cur = (cur + " " + w).trim();
  }
  if (cur) lines.push(cur);
  return lines.slice(0, maxLines);
}

/** 배경 사진을 세로 규격으로 (왜곡 없이) + 어둡게 */
async function bgFrame(sharp, imgUrl, brightness = 0.5, blur = 0) {
  const buf = await fetchPhoto(imgUrl);
  if (!buf) throw new Error("배경 사진 실패");
  let p = sharp(buf).resize(RW, RH, { fit: "cover", position: sharp.strategy.attention })
    .modulate({ brightness, saturation: 1.06 });
  if (blur > 0) p = p.blur(blur);
  return p.toBuffer();
}

/** 인트로 카드 — "부산 돼지국밥 TOP 8" 같은 제목을 크게 */
async function composeIntroCard(sharp, theme, places, title, rankBasis = "") {
  const bg = await bgFrame(sharp, (places.find((p) => p.foodPicked) ?? places[0]).imageUrl, 0.5, 8);
  const lines = wrapLines(title, 10, 3);
  const size = lines.length >= 3 ? 100 : lines.length === 2 ? 116 : 128;
  const lineH = Math.round(size * 1.28);
  const startY = Math.round(RH / 2 - ((lines.length - 1) * lineH) / 2);
  const svg = Buffer.from(
    `<svg width="${RW}" height="${RH}" xmlns="http://www.w3.org/2000/svg">
      ${lines
        .map(
          (l, i) =>
            `<text x="${RW / 2}" y="${startY + i * lineH}" font-family="${TFONT}" font-size="${size}" font-weight="900" fill="#fff" text-anchor="middle" stroke="#000" stroke-width="9" paint-order="stroke">${esc(l)}</text>`
        )
        .join("")}
      <text x="${RW / 2}" y="${startY + lines.length * lineH + 40}" font-family="${FONT}" font-size="48" font-weight="700" fill="#ffd9a0" text-anchor="middle" stroke="#000" stroke-width="6" paint-order="stroke">끝까지 보고 저장하세요</text>
    </svg>`
  );
  return sharp(bg).composite([{ input: svg, top: 0, left: 0 }]).jpeg({ quality: 92 }).toBuffer();
}

/** 순위 카드 — 큰 순위 숫자 + 상호명 + 지역 + 한줄평 */
async function composeRankCard(sharp, place, rank) {
  // 0.62였을 때 사진이 탁해 보인다는 피드백(9/3) — 사진은 살리고 가독성은 하단 박스·외곽선으로
  const bg = await bgFrame(sharp, place.imageUrl, 0.85, 0);
  const nameLines = wrapLines(place.name, 11, 2);
  const nameSize = nameLines.length === 2 ? 78 : 92;
  const clip = (l) => {
    let t = [...l].length > 18 ? [...l].slice(0, 18).join("").replace(/s*S*$/, "") : l;
    return t.replace(/(의|과|와|은|는|이|가|을|를|에|로|도)$/, "").trim(); // 꼬리 조사 제거
  };
  const descLines = place.descLines?.length
    ? place.descLines.slice(0, 2).map(clip)
    : wrapLines(place.desc || "", 16, 2);
  const boxTop = RH - 760;
  const svg = Buffer.from(
    `<svg width="${RW}" height="${RH}" xmlns="http://www.w3.org/2000/svg">
      <!-- 순위 뱃지 -->
      <circle cx="${RW / 2}" cy="330" r="118" fill="#d92121" stroke="#fff" stroke-width="10"/>
      <text x="${RW / 2}" y="${330 + 46}" font-family="${TFONT}" font-size="120" font-weight="900" fill="#fff" text-anchor="middle">${rank}</text>
      <!-- 하단 정보 박스 -->
      <rect x="0" y="${boxTop}" width="${RW}" height="${RH - boxTop - 300}" fill="#000" fill-opacity="0.5"/>
      ${nameLines
        .map(
          (l, i) =>
            `<text x="${RW / 2}" y="${boxTop + 110 + i * Math.round(nameSize * 1.2)}" font-family="${TFONT}" font-size="${nameSize}" font-weight="900" fill="#fff" text-anchor="middle" stroke="#000" stroke-width="7" paint-order="stroke">${esc(l)}</text>`
        )
        .join("")}
      <text x="${RW / 2}" y="${boxTop + 110 + nameLines.length * Math.round(nameSize * 1.2) + 20}" font-family="${FONT}" font-size="52" font-weight="700" fill="#ffd9a0" text-anchor="middle" stroke="#000" stroke-width="5" paint-order="stroke">${esc(place.region || "")}${place.hundred ? " · 백년가게" : ""}</text>
      ${descLines
        .map(
          (l, i) =>
            `<text x="${RW / 2}" y="${boxTop + 110 + nameLines.length * Math.round(nameSize * 1.2) + 100 + i * 58}" font-family="${FONT}" font-size="46" font-weight="600" fill="#f0f0f0" text-anchor="middle" stroke="#000" stroke-width="4" paint-order="stroke">${esc(l)}</text>`
        )
        .join("")}
    </svg>`
  );
  return sharp(bg).composite([{ input: svg, top: 0, left: 0 }]).jpeg({ quality: 92 }).toBuffer();
}

/** 아웃트로 카드 — 저장·팔로우 유도 */
async function composeOutroCard(sharp, places, title) {
  const bg = await bgFrame(sharp, places[0].imageUrl, 0.35, 12);
  const svg = Buffer.from(
    `<svg width="${RW}" height="${RH}" xmlns="http://www.w3.org/2000/svg">
      <text x="${RW / 2}" y="${RH / 2 - 60}" font-family="${TFONT}" font-size="104" font-weight="900" fill="#fff" text-anchor="middle" stroke="#000" stroke-width="9" paint-order="stroke">저장 필수</text>
      <text x="${RW / 2}" y="${RH / 2 + 70}" font-family="${FONT}" font-size="58" font-weight="700" fill="#ffd9a0" text-anchor="middle" stroke="#000" stroke-width="6" paint-order="stroke">${esc(wrapLines(title, 16, 1)[0] || "")}</text>
      <text x="${RW / 2}" y="${RH / 2 + 180}" font-family="${FONT}" font-size="50" font-weight="700" fill="#fff" text-anchor="middle" stroke="#000" stroke-width="5" paint-order="stroke">@${esc(HANDLE)}</text>
    </svg>`
  );
  return sharp(bg).composite([{ input: svg, top: 0, left: 0 }]).jpeg({ quality: 92 }).toBuffer();
}

/** v2 표지 인포그래픽: 레드 배너 + 지역 칩 + 백년가게 배지 + 다크 푸터 */
async function composeCover(theme, places) {
  const sharp = (await import("sharp")).default;
  const W = 1080, HEADER = 180, FOOTER = 84;
  const rows = Math.ceil(places.length / 2);
  const CELL_W = 540, CELL_H = Math.floor((1350 - HEADER - FOOTER) / rows);
  const H = HEADER + CELL_H * rows + FOOTER;
  const PHOTO_W = 250, PAD = 12;
  const emoji = theme.emoji || "💡";
  // 홀수 개수면 마지막 카드는 가운데 정렬 (빈 칸 방지)
  const cellPos = (i) => {
    const lastOdd = places.length % 2 === 1 && i === places.length - 1;
    const col = i % 2, row = Math.floor(i / 2);
    return { x: lastOdd ? (W - CELL_W) / 2 : col * CELL_W, y: HEADER + row * CELL_H };
  };

  const photoLayers = [];
  const cellBufs = {};
  for (let i = 0; i < places.length; i++) {
    try {
      const buf = await fetchPhoto(places[i].imageUrl, places[i].name);
      if (!buf) continue;
      cellBufs[i] = buf;
      const { x, y } = cellPos(i);
      const resized = await sharp(buf)
        .resize(PHOTO_W, CELL_H - PAD * 2, { fit: "cover" })
        .jpeg({ quality: 82 })
        .toBuffer();
      photoLayers.push({
        input: resized,
        left: x + CELL_W - PHOTO_W - PAD,
        top: y + PAD,
      });
    } catch { /* 사진 실패 시 텍스트만 */ }
  }

  // 헤더 양옆 원형 음식 사진 (음식으로 판별된 사진 우선)
  const D = 128, RING_Y = 26;
  const headerPickIdx = places
    .map((p, i) => ({ i, food: !!p.foodPicked }))
    .filter((v) => cellBufs[v.i])
    .sort((a, b) => Number(b.food) - Number(a.food))
    .slice(0, 2)
    .map((v) => v.i);
  const circleMask = Buffer.from(
    `<svg width="${D}" height="${D}"><circle cx="${D / 2}" cy="${D / 2}" r="${D / 2}" fill="#fff"/></svg>`
  );
  const headerPos = [{ left: 48 }, { left: W - 48 - D }];
  for (let k = 0; k < headerPickIdx.length; k++) {
    try {
      const circ = await sharp(cellBufs[headerPickIdx[k]])
        .resize(D, D, { fit: "cover" })
        .composite([{ input: circleMask, blend: "dest-in" }])
        .png()
        .toBuffer();
      photoLayers.push({ input: circ, left: headerPos[k].left, top: RING_Y });
    } catch { /* 없어도 무방 */ }
  }

  let bgCells = "", textCells = "";
  for (let i = 0; i < places.length; i++) {
    const p = places[i];
    const { x, y } = cellPos(i);
    const nm = coverName(p.name);
    const ns = nm.length <= 7 ? 30 : nm.length <= 9 ? 25 : 20;
    const d1 = (p.desc ?? "").slice(0, 12), d2 = (p.desc ?? "").slice(12, 24);
    const chipW = p.region.length * 20 + 46;
    bgCells += `<rect x="${x + 8}" y="${y + 6}" width="${CELL_W - 16}" height="${CELL_H - 12}" rx="16" fill="white" stroke="#f1dede" stroke-width="2"/>`;
    textCells += `
    <g>
      <rect x="${x + PAD + 8}" y="${y + PAD + 10}" width="44" height="44" rx="12" fill="#d92121"/>
      <text x="${x + PAD + 30}" y="${y + PAD + 42}" font-family="${FONT}" font-size="28" font-weight="800" fill="#fff" text-anchor="middle">${i + 1}</text>
      <text x="${x + PAD + 62}" y="${y + PAD + 40}" font-family="${TFONT}" font-size="${ns}" font-weight="800" fill="${PAL.name}">${esc(nm)}</text>
      <rect x="${x + PAD + 8}" y="${y + PAD + 58}" width="${chipW}" height="34" rx="17" fill="#f6ede7"/>
      <text x="${x + PAD + 8 + chipW / 2}" y="${y + PAD + 82}" font-family="${FONT}" font-size="20" font-weight="700" fill="#8a5a44" text-anchor="middle">📍 ${esc(p.region)}</text>
      ${p.hundred ? `<rect x="${x + PAD + 8 + chipW + 8}" y="${y + PAD + 58}" width="110" height="34" rx="17" fill="#fff3d6" stroke="#e8c66a" stroke-width="1.5"/>
      <text x="${x + PAD + 8 + chipW + 63}" y="${y + PAD + 82}" font-family="${FONT}" font-size="19" font-weight="800" fill="#9a7419" text-anchor="middle">백년가게</text>` : ""}
      <text x="${x + PAD + 10}" y="${y + PAD + 128}" font-family="${FONT}" font-size="22" fill="#333">${emoji} ${esc(d1)}</text>
      ${d2 ? `<text x="${x + PAD + 10}" y="${y + PAD + 158}" font-family="${FONT}" font-size="22" fill="#333">${esc(d2)}</text>` : ""}
    </g>`;
  }

  const titleText = String(theme.titleResolved || theme.title);
  const titleSize = titleText.length <= 11 ? 58 : titleText.length <= 14 ? 50 : 43;
  const bgSvg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <rect x="0" y="0" width="${W}" height="${HEADER}" fill="#d92121"/>
    <text x="${W / 2}" y="80" font-family="${TFONT}" font-size="${titleSize}" font-weight="900" fill="#ffffff" text-anchor="middle">${esc(titleText)}</text>
    <text x="${W / 2}" y="138" font-family="${FONT}" font-size="25" font-weight="600" fill="#ffd9d9" text-anchor="middle">✦ 저장해두고 하나씩 정복해 보세요 ✦</text>
    ${bgCells}
    <rect x="0" y="${H - FOOTER}" width="${W}" height="${FOOTER}" fill="#2b2323"/>
    <text x="${W / 2}" y="${H - FOOTER + 38}" font-family="${FONT}" font-size="25" font-weight="700" fill="#ffffff" text-anchor="middle">여러분의 추천 맛집도 댓글로 남겨주세요 💬</text>
    <text x="${W / 2}" y="${H - FOOTER + 68}" font-family="${FONT}" font-size="21" fill="#c9b8b8" text-anchor="middle">@${HANDLE}</text>
  </svg>`;
  // 헤더 원형 사진 흰 테두리 (사진 위에 그려짐)
  const rings = headerPickIdx
    .map((_, k) => `<circle cx="${headerPos[k].left + D / 2}" cy="${RING_Y + D / 2}" r="${D / 2 + 3}" fill="none" stroke="#ffffff" stroke-width="6"/>`)
    .join("");
  const textSvg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${rings}${textCells}</svg>`;

  const out = path.join(TMP, "cover.jpg");
  await sharp({ create: { width: W, height: H, channels: 3, background: "#fdf6f2" } })
    .composite([
      { input: Buffer.from(bgSvg), left: 0, top: 0 },
      ...photoLayers,
      { input: Buffer.from(textSvg), left: 0, top: 0 },
    ])
    .jpeg({ quality: 88 })
    .toFile(out);
  console.log(`표지 합성 완료: ${places.length}곳, ${W}x${H}`);
  return out;
}

/** 뒷장 상세 슬라이드: 사진(1080x1350) + 하단 이름·지역·상세설명 바 합성 */
async function composeSlide(place, rank) {
  const sharp = (await import("sharp")).default;
  const W = 1080, H = 1350, BAR = 250;
  const slideBuf = await fetchPhoto(place.imageUrl, place.name);
  if (!slideBuf) throw new Error("slide img 실패");
  const photo = await sharp(slideBuf)
    .resize(W, H, { fit: "cover" })
    .jpeg({ quality: 85 })
    .toBuffer();
  const nm = place.name.length > 15 ? place.name.slice(0, 14) + "…" : place.name;
  const ns = nm.length <= 9 ? 44 : nm.length <= 12 ? 36 : 30;
  // 상세 설명 2줄 래핑 (한 줄 최대 22자)
  const detail = String(place.detail ?? "");
  const d1 = detail.slice(0, 22), d2 = detail.slice(22, 44);
  const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <rect x="0" y="${H - BAR}" width="${W}" height="${BAR}" fill="#000000" fill-opacity="0.66"/>
    <rect x="28" y="${H - BAR + 30}" width="64" height="64" rx="16" fill="#d92121"/>
    <text x="60" y="${H - BAR + 75}" font-family="${FONT}" font-size="38" font-weight="800" fill="#fff" text-anchor="middle">${rank}</text>
    <text x="116" y="${H - BAR + 60}" font-family="${TFONT}" font-size="${ns}" font-weight="800" fill="#ffffff">${esc(nm)}</text>
    <text x="116" y="${H - BAR + 100}" font-family="${FONT}" font-size="26" fill="#e5d8d8">📍 ${esc(place.region)}${place.hundred ? " · 백년가게 인증" : ""}</text>
    <text x="44" y="${H - BAR + 158}" font-family="${FONT}" font-size="29" font-weight="600" fill="#ffffff">${esc(d1)}</text>
    ${d2 ? `<text x="44" y="${H - BAR + 202}" font-family="${FONT}" font-size="29" font-weight="600" fill="#ffffff">${esc(d2)}</text>` : ""}
  </svg>`;
  const out = path.join(TMP, `slide_${rank}.jpg`);
  await sharp(photo).composite([{ input: Buffer.from(svg), left: 0, top: 0 }]).jpeg({ quality: 86 }).toFile(out);
  return out;
}

/** 받침 유무 조사 선택 */
function josa(word, withBatchim, without) {
  const code = word.charCodeAt(word.length - 1);
  if (code < 0xac00 || code > 0xd7a3) return withBatchim;
  return (code - 0xac00) % 28 > 0 ? withBatchim : without;
}

/** 댓글 참여 유도 문구 (전부 "추천 맛집 댓글로" 뉘앙스, 랜덤 회전) */
function engagementLine(theme, count) {
  const spot = theme.keyword === "카페" ? "카페" : `${theme.keyword} 맛집`;
  const pool = [
    `여러분의 인생 ${spot}${josa(spot, "은", "는")} 어디인가요? 추천 맛집을 댓글로 남겨주세요 🙌`,
    `우리 동네 ${spot}${josa(spot, "이", "가")} 최고다! 하시는 분들, 그 집을 댓글로 추천해 주세요 🔥`,
    `이 리스트에 없는 숨은 명가가 있다면, 여러분이 아는 진짜 ${theme.keyword} 성지를 댓글로 추천해 주세요 👀`,
    `1~${count}번 중 가보신 곳 있나요? 후기와 함께 여러분만의 추천 맛집도 댓글로 남겨주세요 🙋`,
    `같이 가고 싶은 사람을 댓글에 태그해 보세요 🤝 여러분만 아는 추천 ${spot}도 댓글로 남겨주시면 최고예요!`,
    `댓글로 추천해 주신 곳은 다음 모음집 후보에 올려드려요! 여러분의 원픽 ${spot}${josa(spot, "을", "를")} 댓글로 추천해 주세요 ✍️`,
  ];
  return pool[Math.floor(Math.random() * pool.length)];
}

function buildCaption(theme, places, descending = false, ep = null, basis = "") {
  // 공개형 — "어디야→DM" 유도 문구 없음. 참여(추천 댓글)·저장 유도만.
  // descending: 카운트다운 영상과 같은 순서(N위 → 1위)로 번호를 매긴다.
  const lines = places.map((p, i) => {
    const num = descending ? places.length - i : i + 1;
    return `${num}. ${p.name}${p.hundred ? " 🏅" : ""} (${p.region})
   ${p.detail || p.desc}`;
  });
  const hundredCount = places.filter((p) => p.hundred).length;
  const goodShops = places.filter((p) => p.goodPrice);
  const hundredLine =
    (hundredCount > 0
      ? `🏅 표시된 ${hundredCount}곳은 중소벤처기업부 인증 '백년가게'예요!\n`
      : "") +
    (goodShops.length > 0
      ? `💰 ${goodShops.map((p) => p.name).join(", ")}: 정부 지정 '착한가격업소'예요!\n`
      : "") +
    (hundredCount > 0 || goodShops.length > 0 ? "\n" : "");
  // 2025-12부터 게시물당 해시태그 5개 제한 — 테마 태그(최대 3) + 큐레이션 2개만.
  // 검색 유입은 해시태그가 아니라 첫 줄의 [음식+맛집] 키워드가 담당한다.
  const tags = [...(theme.tags ?? []).slice(0, 3), "맛집추천", "맛집리스트"]
    .slice(0, 5)
    .map((t) => `#${t}`)
    .join(" ");
  // EP 넘버링(시리즈 브랜딩)과 다음 편 예고 — "다음 편을 놓치기 싫어서"가 팔로우의
  // 메커니즘. 단 "팔로우하면 공개" 같은 조건형은 참여 낚시로 강등되므로 예고만 한다.
  // 저장 CTA는 TPO형·타깃 지정형 순환 — 저장·DM공유가 2026 도달의 핵심 신호.
  const saveCta = [
    `📌 나중에 못 찾지 않게 지금 저장해 두세요!`,
    `📌 출장·여행 갈 때 꺼내볼 수 있게 저장해 두세요!`,
    `📌 ${theme.keyword}에 진심인 친구에게 이 리스트를 보내주세요!`,
  ][Math.floor(Math.random() * 3)];
  return (
    `🔥 ${ep ? `전국맛집로드 EP.${ep} | ` : ""}${theme.titleResolved || theme.title}\n\n` +
    `${lines.join("\n")}\n\n` +
    hundredLine +
    (basis ? `🔎 선정 기준: ${basis} 실데이터 집계\n\n` : "") +
    `💬 ${engagementLine(theme, places.length)}\n` +
    `🗺 ${places.length}곳 지도 링크가 필요하면 댓글에 '지도'라고 남겨주세요\n\n` +
    `${saveCta}\n` +
    `⏰ 내일 저녁 5시 반, 다음 편으로 이어집니다\n\n` +
    tags // 사진 출처 라인 제외 (2026-09-03 사용자 지시)
  );
}

async function main() {
  // ── 오프라인 렌더 모드: 시크릿·DB·외부 API 없이 표지·카드만 렌더 ──
  // 클라우드 세션(claude.ai/code)이나 .env 없는 환경에서 디자인 수정을 눈으로
  // 검증하는 용도. data/dry-sample.json(실제 DRY 수집 결과)을 그대로 compose에 넣는다.
  //   ROUNDUP_OFFLINE=1 npx tsx scripts/make-roundup.mjs
  //   → roundup-reel-preview.jpg / carousel-preview-*.jpg 생성 (발행·DB 접근 없음)
  if (process.env.ROUNDUP_OFFLINE === "1") {
    const { theme, places } = JSON.parse(
      fs.readFileSync(new URL("../data/dry-sample.json", import.meta.url), "utf8")
    );
    const sharpMod = (await import("sharp")).default;
    if (process.env.COVER_TFONT) TFONT = process.env.COVER_TFONT;
    fs.copyFileSync(await composeReelCover(theme, places, false, null), "roundup-reel-preview.jpg");
    const pad = (n) => String(n).padStart(2, "0");
    await sharpMod("roundup-reel-preview.jpg").extract({ left: 0, top: 285, width: 1080, height: 1350 })
      .jpeg({ quality: 90 }).toFile("carousel-preview-01-cover.jpg");
    for (let i = 0; i < places.length; i++) {
      fs.writeFileSync(`carousel-preview-${pad(i + 2)}-card.jpg`, await composeCarouselCard(sharpMod, places[i], i + 1));
    }
    await sharpMod(await composeChecklistCard(sharpMod, theme, places))
      .extract({ left: 0, top: 285, width: 1080, height: 1350 }).jpeg({ quality: 90 })
      .toFile(`carousel-preview-${pad(places.length + 2)}-checklist.jpg`);
    fs.writeFileSync("countdown-card-preview.jpg", await composeRankCard(sharpMod, places[0], 1));
    // 무사진 칸 시안 — 2·5번 칸을 비운 표지를 따로 렌더
    if (process.env.NOPHOTO_DEMO === "1") {
      const keep = process.env.ROUNDUP_NOPHOTO;
      process.env.ROUNDUP_NOPHOTO = "2,5";
      fs.copyFileSync(await composeReelCover(theme, places, false, null), "roundup-nophoto-preview.jpg");
      if (keep === undefined) delete process.env.ROUNDUP_NOPHOTO; else process.env.ROUNDUP_NOPHOTO = keep;
      console.log("오프라인 — roundup-nophoto-preview.jpg 저장 (2·5번 칸 무사진 시안)");
    }
    // 그리드 릴스 첫 3초 훅 컷 — 실발행과 같은 렌더러로 뽑아 폰에서 그림으로 확인한다
    const hook = await buildHookCut(theme, places, null);
    if (hook) fs.copyFileSync(hook, "roundup-hook-preview.jpg");
    // ffmpeg가 있으면 8초 릴스(훅 3초 + 표지 5초)까지 실제로 이어붙여 본다
    if (hook && process.env.OFFLINE_RENDER === "1") {
      const total = await renderPagesReel(
        [{ path: hook, sec: 3 }, { path: "roundup-reel-preview.jpg", sec: 5 }],
        null,
        "roundup-reel-preview.mp4"
      );
      console.log(`오프라인 릴스 렌더 — roundup-reel-preview.mp4 (${total}초)`);
    }
    console.log(`오프라인 렌더 완료 (${theme.titleResolved}) — roundup-hook-preview.jpg, roundup-reel-preview.jpg, carousel-preview-01~${pad(places.length + 2)}.jpg, countdown-card-preview.jpg`);
    return;
  }

  const { db, initDb } = await import("../lib/db.ts");
  const themesData = JSON.parse(
    fs.readFileSync(new URL("../data/roundup-themes.json", import.meta.url), "utf8")
  );
  await initDb();
  // title_font·reel_format 컬럼은 lib/db.ts initDb 마이그레이션에서 만든다 —
  // 여기서만 만들면 발행이 한 번 돌기 전까지 컬럼이 없어 조회 전용 리포트가 죽는다(9/8 실측).

  // 발행 쿨다운(행동차단 회복) 중이면 모음집도 쉼 — 시도 반복이 차단을 연장시킴
  if (!DRY) {
    const cd = await db.execute("SELECT value FROM config WHERE key='publish_cooldown_until'");
    if (cd.rows.length > 0) {
      const until = new Date(String(cd.rows[0].value).replace(" ", "T") + "Z").getTime();
      if (Date.now() < until) {
        console.log("발행 쿨다운 중 — 모음집 건너뜀 (" + Math.round((until-Date.now())/60000) + "분 남음)");
        return;
      }
    }
  }

  // 하루 1회 가드 — GitHub 크론이 5~11시간씩 밀려(실측 8/27~31) 저녁 발행이
  // 심야로 밀렸다. 릴스처럼 크론을 촘촘히 걸고, 오늘 이미 발행했으면 조용히 종료.
  // (같은 형식만 검사 — 정오 큐레이션이 저녁 모음집을 막으면 안 된다. DRY는 발행이
  //  없으니 가드 대상이 아님 — 로컬 미리보기 검증이 실발행에 막히면 안 된다)
  if (FORCE) console.log("강제 재발행 모드 — 하루 1회 가드 생략, 테마:", process.env.ROUNDUP_THEME);
  if (!DRY && !FORCE) {
    // 발행 도중 죽어 30분 넘게 'publishing'인 행은 실패로 확정 (러너 15분 타임아웃보다 김).
    // 아래 가드가 이런 행을 "오늘 이미 발행"으로 세지 않게 하려는 것.
    await db.execute(
      `UPDATE posts SET status = 'failed'
        WHERE status = 'publishing' AND ig_media_id IS NULL
          AND created_at < datetime('now', '-30 minutes')`
    );
    const prefix =
      process.env.ROUNDUP_STYLE === "countdown" ? "countdown-%"
      : process.env.ROUNDUP_STYLE === "carousel" ? "carousel-%"
      : "roundup-%";
    const today = await db.execute({
      // KST 날짜 기준(UTC면 KST 새벽 수동 발행이 전날로 묶임). 'publishing'은 진행 중(30분 이내)만 인정.
      sql: `SELECT 1 FROM posts WHERE content_id LIKE ?
              AND date(created_at, '+9 hours') = date('now', '+9 hours')
              AND (status = 'published' OR (status = 'publishing' AND created_at >= datetime('now', '-30 minutes')))
              LIMIT 1`,
      args: [prefix],
    });
    if (today.rows.length) {
      console.log("오늘 이미 발행됨 — 이번 회차 건너뜀");
      return;
    }
  }

  // 저녁 모음집 요일 슬롯 (2026-09-03 사용자 지시: 상권 > 지역 > 동일음식 전국 순으로 많이):
  //   화·목·토 = 상권(반경 1.5km 동네 맛집) 3회 / 월·금 = 지역(도시 종합 + 권역×음식) 2회 /
  //   수·일 = 전국 음식 테마 2회. 슬롯마다 포인터 따로. 큐레이션·캐러셀은 음식 테마만.
  //   ※ 도시×단일음식(춘천 닭갈비 등)은 실측 풀 0~9곳이라 불가 — 권역 단위까지만.
  const kstDow = new Date(Date.now() + 9 * 3600 * 1000).getUTCDay(); // 0=일
  const SLOT_BY_DOW = ["nation", "city", "spot", "nation", "spot", "city", "spot"]; // 일~토
  const slot = process.env.ROUNDUP_STYLE ? "food" : SLOT_BY_DOW[kstDow];
  const isSpot = (t) => t.mode === "area" && t.tour?.mapX;
  const isCity = (t) => (t.mode === "area" && !t.tour?.mapX) || (t.mode !== "area" && (t.areaCode || t.areaCodes));
  const inSlot = (t) =>
    slot === "spot" ? isSpot(t)
    : slot === "city" ? isCity(t)
    : slot === "nation" ? t.mode !== "area" && !t.areaCode && !t.areaCodes
    : t.mode !== "area"; // food: 큐레이션·캐러셀 (전국+권역 음식)
  // 테마 선택: 단순 로테이션 (포인터 순서대로, 수집 부족 시 다음 테마)
  // 모음집(grid)과 큐레이션(countdown)은 포인터를 따로 둬 같은 테마가 겹치지 않게 함
  const IDX_KEY =
    process.env.ROUNDUP_STYLE === "countdown" ? "countdown_idx"
    : process.env.ROUNDUP_STYLE === "carousel" ? "carousel_idx"
    : slot === "spot" ? "spot_idx" : slot === "city" ? "city_idx" : "roundup_idx";
  const idxRow = await db.execute({
    sql: "SELECT value FROM config WHERE key = ?",
    args: [IDX_KEY],
  });
  const idx = idxRow.rows.length ? Number(idxRow.rows[0].value) : 0;
  const allThemes = themesData.themes;
  const all = allThemes.filter(inSlot);
  console.log(`오늘 슬롯: ${slot} — 풀 ${all.length}개`);
  // 조회수 성과로 가중한 순서 (데이터가 없거나 조회 실패면 기존 단순 로테이션)
  const perf = await themeWeights(db, all);
  const ordered = perf
    ? weightedOrder(all, perf.weights, perf.recent)
    : all.map((_, i) => all[(idx + i) % all.length]);
  if (perf?.recent.length) console.log("직전 테마 제외:", perf.recent.join(", "));
  console.log("테마 시도 순서:", ordered.slice(0, 3).map((t) => t.key).join(" → "));

  let theme = null, places = [];
  // ROUNDUP_THEME=키 를 주면 그 테마만 시도 (테스트·수동 발행용)
  if (process.env.ROUNDUP_THEME) {
    const forced = allThemes.find((t) => t.key === process.env.ROUNDUP_THEME);
    if (forced) {
      console.log("테마 강제:", forced.key);
      const got = await collectPlaces(forced, forced.areaCode || forced.mode === "area" ? 24 : 16); // 지자체 소스는 대표사진에 외관 컷이 많아 비전 통과율이 낮다(제주 실측 33%) — 풀을 넉넉히
      console.log(`[${forced.key}] 수집 풀: ${got.length}곳`);
      if (got.length < 4) throw new Error("강제 테마 수집 부족");
      theme = forced;
      places = got;
    }
  }

  // 표지 한 장에 6칸(2열x3행)까지만 — 8칸이면 셀이 좁아 상호명·설명이 잘리고
  // 피드에서 확대하기 전엔 아무것도 안 읽힌다(실측).
  //
  // 풀을 10곳 이상 요구하는 이유: 뒤이어 음식 사진 검증에서 몇 곳이 탈락하는데,
  // 딱 6곳만 모인 테마(예: 제주 흑돼지 9곳)를 잡으면 6칸을 못 채워 그날 발행이
  // 통째로 날아간다. 여유가 있는 테마를 먼저 쓰고, 전부 얇으면 그중 제일 큰 풀을 쓴다.
  // 음식 사진 검증을 표지 구성보다 먼저 한다.
  // 왜: 비전이 음식 사진을 못 찾으면 예전에는 원본(간판·외관)을 그대로 썼고,
  //     그 결과 표지에 가게 간판이 올라갔다. 검증 통과한 곳만 표지에 세우고
  //     탈락한 곳은 다음 후보로 대체한다. (무료 등급 분당 한도 고려해 4초 간격)
  // 통과가 4곳 미만이면 그 테마는 포기하고 다음 테마로 넘어간다 (9/4 실측: 서울 상권 풀은
  // 서울 DB 저해상도 메뉴 사진이 대부분이라 해상도 게이트 뒤에 6곳이 안 나올 수 있다).
  // 테마를 돌더라도 전체 8분 예산 안에서 — 넘기면 확보한 만큼으로 진행한다.
  // 같은 브랜드 지점은 한 곳만 — 본점·무지점명을 우선하고 나머지 지점은 뺀다
  // (실측: 홍대 편에 벽제갈비 본점·신촌점이 함께 선정됨). 비전 전에 걸러야 비전 호출도 절약.
  function dedupeBrand(list) {
    const byBrand = new Map();
    for (const p of list) {
      const k = brandOf(p.name);
      const cur = byBrand.get(k);
      if (!cur || (isBranchName(cur.name) && !isBranchName(p.name))) byBrand.set(k, p);
    }
    if (byBrand.size < list.length) console.log(`브랜드 중복 제거: ${list.length} → ${byBrand.size}곳`);
    return [...byBrand.values()];
  }
  const NEED = 6;
  const PHOTO_PHASE_BUDGET_MS = 8 * 60 * 1000;
  const photoDeadline = Date.now() + PHOTO_PHASE_BUDGET_MS;
  async function pickPhotos(cands, th) {
    const ok = [];
    for (const p of dedupeBrand(cands)) {
      if (ok.length >= NEED) break;
      if (Date.now() > photoDeadline) {
        console.log(`사진 판정 시간 예산(8분) 초과 — 확보한 ${ok.length}곳으로 진행`);
        break;
      }
      await pickFoodImage(p, th.food);
      if (p.foodPicked) ok.push(p);
      else console.log(`  음식 사진 없음 → 제외: ${p.name}`);
      await new Promise((r) => setTimeout(r, 4000));
    }
    return ok;
  }
  let passed = [];
  if (theme) {
    passed = await pickPhotos(places, theme);
  } else {
    let best = null;
    for (let t = 0; t < Math.min(5, ordered.length) && Date.now() < photoDeadline; t++) {
      const cand = ordered[t];
      const got = await collectPlaces(cand, cand.areaCode || cand.mode === "area" ? 24 : 16); // 지자체 소스는 대표사진에 외관 컷이 많아 비전 통과율이 낮다(제주 실측 33%) — 풀을 넉넉히
      console.log(`[${cand.key}] 수집 풀: ${got.length}곳`);
      if (got.length < 6) continue;
      const ok = await pickPhotos(got, cand);
      if (!best || ok.length > best.passed.length) best = { theme: cand, places: got, passed: ok };
      if (ok.length >= NEED) break;
      console.log(`[${cand.key}] 음식 사진 ${ok.length}곳 — ${ok.length >= 4 ? "보류하고 " : ""}다음 테마 시도`);
    }
    if (!best) throw new Error("수집 가능한 테마 없음");
    theme = best.theme; places = best.places; passed = best.passed;
  }
  const useCount = passed.length >= 6 ? 6 : passed.length >= 4 ? 4 : 0;
  if (!useCount) {
    console.log(`⏭️ 음식 사진 확보 ${passed.length}곳뿐 — 이번 모음집 발행 건너뜀`);
    return;
  }
  places = passed.slice(0, useCount);
  console.log(`음식 사진 확보: ${places.length}곳 (${theme.key})`);

  // 자극형 제목 랜덤 생성
  const tt = buildPunchyTitle(theme, places.length);
  theme.titleResolved = tt.text;
  theme.coverParts = tt;
  console.log("제목:", theme.titleResolved);

  // 백년가게 대조 (배지·캡션용)
  await markHundredYear(db, places);
  console.log(`백년가게: ${places.filter((p) => p.hundred).length}곳`);
  const { markGoodPrice } = await import("../lib/goodprice.ts");
  console.log(`착한가격업소: ${markGoodPrice(places)}곳`);

  // 한줄평+상세설명 먼저 (비전 호출이 분당 한도를 소모하기 전에)
  // 모든 AI(Gemini→Groq)가 실패하면 저품질 기본 문구로 내보내지 않고 발행 자체를 건너뜀
  await enrichPlaces(places);
  const descs = await makeDescriptions(theme, places);
  if (!descs) {
    console.log("⏭️ AI 한도 소진 (Gemini/Groq 모두 실패) — 이번 모음집 발행 건너뜀");
    return;
  }
  places.forEach((p, i) => {
    p.descLines = descs[i].lines;
    p.desc = descs[i].short;
    p.detail = descs[i].detail;
  });


  // 발행 스타일
  //  - grid(기본): 기존 모음집 — 리스트 인포그래픽 한 장을 릴스로
  //  - countdown: 큐레이션 — 인트로 + 순위 카드 순차 공개 + 아웃트로 (1위 보려고 끝까지 봄)
  const STYLE =
    process.env.ROUNDUP_STYLE === "countdown" ? "countdown"
    : process.env.ROUNDUP_STYLE === "carousel" ? "carousel"
    : "grid";
  const sharpMod = (await import("sharp")).default;

  // 표지 3안 순환 결정을 먼저 한다 — hero는 카운트다운형(표지→6위→…→1위)으로
  // 렌더하므로 랭킹·캡션 단계 전에 스타일을 알아야 한다.
  // (히어로 단독 표지는 "식당 영상이 없다"(8/24 감자탕), 2컷 절충도 부족하다는
  //  피드백으로 순차 공개형으로 확정 — 흑돼지 큐레이션과 같은 구성)
  let coverStyle = null;
  if (STYLE === "carousel") coverStyle = "carousel"; // 성과 추적용 (cover_idx 순환과 무관)
  if (STYLE === "grid") {
    // 순환 정의와 근거는 COVER_STYLES(모듈 상단) 참조. 판정은 cover-report.
    if (process.env.COVER_STYLE && COVER_STYLES.includes(process.env.COVER_STYLE)) {
      coverStyle = process.env.COVER_STYLE; // 시안 확인용 수동 지정
    } else {
      const ci = await db.execute("SELECT value FROM config WHERE key = 'cover_idx'");
      coverStyle = COVER_STYLES[(ci.rows.length ? Number(ci.rows[0].value) : 0) % COVER_STYLES.length];
    }
    console.log("표지 스타일:", coverStyle);
  }

  // 표지 서체 A/B (2026-09-02 사용자 지시): G마켓 산스 vs 잘난체 — 그리드 모음집에서만
  // 발행마다 교대. 판정은 cover-report.mjs의 서체별 평균. 수동 COVER_TFONT 회차는
  // 표본을 흔들지 않도록 A/B에서 제외(포인터도 안 움직임).
  const manualFont = Boolean(process.env.COVER_TFONT);
  let titleFont = manualFont ? "manual" : "gmarket";
  if (STYLE === "grid" && !manualFont) {
    const fi = await db.execute("SELECT value FROM config WHERE key = 'font_idx'");
    titleFont = (fi.rows.length ? Number(fi.rows[0].value) : 0) % 2 === 0 ? "gmarket" : "jalnan";
    TFONT = FONT_AB[titleFont];
    console.log("표지 서체:", titleFont);
  }

  // 카운트다운형 렌더(순위 공개 시퀀스)를 타는 모드: 큐레이션 + hero 모음집
  const cdMode = STYLE === "countdown" || coverStyle === "hero";

  // 순위 근거: 네이버 '블로그 후기 수'. 실제 방문·후기가 많을수록 인기 있는 집이라
  // 임의 순서가 아닌 근거 있는 랭킹이 된다. (데이터랩은 신규 등록이 막혀 사용 불가)
  // 키가 없거나 실패하면 수집 순서를 그대로 쓴다.
  let rankBasis = "";
  {
    // "데이터 검증" 콘셉트(2026-09 트렌드 반영): 랭킹을 카운트다운뿐 아니라 grid·
    // 캐러셀에도 적용 — 카드에 근거 수치(블로그·유튜브)를 배지로 노출하고 셀 순서도
    // 인기순이 된다. 우리만 가진 4축 실데이터가 콘셉트 차별화의 핵심.
    try {
      // 4축 합성 랭킹: 블로그 후기 수 + 카페글 + 유튜브 상위 조회수 + 네이버 리뷰순 진입.
      // 유튜브·리뷰순 키가 없거나 실패하면 그 축만 0점 — 블로그 단독과 동등하게 동작.
      const { rankComposite } = await import("../lib/ranking.ts");
      const res = await rankComposite(places, theme.mode === "area" ? "맛집" : theme.keyword);
      if (res?.scored) {
        places = res.ranked; // 1위가 앞
        rankBasis = res.basis;
        console.log(
          "합성 순위:",
          places
            .map((p) => `${p.name}(블로그${p.buzz}·YT${Math.round(p.ytViews / 1000)}k${p.commentPos ? `·리뷰${p.commentPos}위` : ""})`)
            .join(" > ")
        );
      } else {
        console.log("랭킹 데이터 없음 — 수집 순서 사용");
      }
    } catch (e) {
      console.error("후기 랭킹 실패(수집 순서 사용):", String(e).slice(0, 100));
    }
  }
  // 카운트다운은 릴스 완주율을 위해 상위 5곳만 쓴다(8곳이면 45초+로 길어져 이탈).
  // 8곳을 수집한 뒤 후기순 상위 5곳을 고르는 것이라 오히려 품질은 올라간다.
  if (STYLE === "countdown" && places.length > 5) {
    places = places.slice(0, 5);
    const tt5 = buildPunchyTitle(theme, places.length);
    theme.titleResolved = tt5.text;
    theme.coverParts = tt5;
    console.log(`TOP 5로 축소 → ${theme.titleResolved}`);
  }

  // 카운트다운은 '아래 순위 → 1위' 순으로 뒤집어 공개
  const ranked = cdMode ? [...places].reverse() : places;

  // 에피소드 번호 = 지금까지 발행된 모음집·큐레이션 수 + 1 (시리즈 브랜딩)
  let ep = null;
  try {
    const c = await db.execute(
      "SELECT COUNT(*) AS n FROM posts WHERE category = '모음집' AND status = 'published'"
    );
    ep = Number(c.rows[0]?.n ?? 0) + 1;
  } catch { /* 실패해도 EP 없이 진행 */ }

  // ⚠️ 캡션은 순위가 확정된 뒤에 만든다(정렬 전에 만들면 번호가 영상과 어긋남).
  //    카운트다운은 영상과 같은 순서로 N위 → 1위 내림차순 표기.
  const caption = cdMode
    ? buildCaption(theme, ranked, true, ep, rankBasis)
    : buildCaption(theme, places, false, ep, rankBasis);

  const cards = []; // countdown에서 쓸 카드 파일들
  let pkBg = null; // 포토코리아 배경 (쓰면 캡션에 출처표시 의무)
  const narration = []; // 카드와 1:1 대응하는 나레이션 문장
  let reelCover = null;
  if (cdMode) {
    const intro = path.join(TMP, "c_intro.jpg");
    if (coverStyle === "hero") {
      // hero 인트로 = 히어로 풀샷 표지 (포토코리아 우선)
      pkBg = theme.mode === "area" ? null : await photoKoreaPhoto(theme.keyword);
      if (pkBg) console.log(`포토코리아 배경: ${pkBg.title}${pkBg.photographer ? " ⓒ" + pkBg.photographer : ""}`);
      fs.copyFileSync(await composeHeroCover(theme, places, pkBg?.url), intro);
    } else
    fs.writeFileSync(
      intro,
      await composeIntroCard(sharpMod, theme, places, theme.titleResolved, rankBasis)
    );
    cards.push(intro);
    // 컷 길이 = 나레이션 길이 비례. 인트로가 제목 전체(~30자)를 읽으면 첫 식당까지
    // 5초 가까이 걸린다("넘어가는 시간이 너무 길다" 피드백). 제목은 인트로 카드가
    // 이미 보여주므로 음성은 짧게 치고 바로 순위로 들어간다.
    // 시그니처 오프닝 — 목소리 캐릭터를 계정 자산화(뉴스 브리핑 포맷)
    narration.push(`맛집 브리핑, ${theme.food || theme.keyword} 톱${ranked.length}. ${ranked.length}위부터 갑니다`);

    for (let i = 0; i < ranked.length; i++) {
      const rank = ranked.length - i; // N위 → 1위
      const f = path.join(TMP, `c_rank_${rank}.jpg`);
      try {
        fs.writeFileSync(f, await composeRankCard(sharpMod, ranked[i], rank));
        cards.push(f);
        const p = ranked[i];
        // 컷 길이 = 그 컷의 나레이션 길이. 표지용 설명(45~65자)을 다 읽으면 식당당
        // 컷이 늘어진다(실측 8/21 어탕 5선: "식당 간 간격이 너무 길다" 피드백).
        // 순위 공개는 빠르게 넘기는 맛 — 2~5위는 이름만 읽고(설명은 화면 자막이 보여줌),
        // 1위만 핵심 한 조각을 붙여 정점을 만든다.
        const bite = p.descLines?.[0] ?? String(p.desc ?? "").split(/[,.]/)[0].trim();
        narration.push(
          rank === 1
            ? `대망의 1위, ${p.region ? p.region + " " : ""}${p.name}${bite ? `. ${bite}` : ""}`
            : `${rank}위, ${p.region ? p.region + " " : ""}${p.name}`
        );
      } catch (e) {
        console.error(`순위 카드 ${rank} 실패(건너뜀):`, String(e).slice(0, 90));
      }
    }
    const outro = path.join(TMP, "c_outro.jpg");
    try {
      // 체크리스트 카드는 릴스에서 제외 (사용자 피드백 2026-09-02 "너무 이상하다")
      // — 캐러셀 마지막 장에만 유지. 릴스 아웃트로는 기존 카드로.
      fs.writeFileSync(outro, await composeOutroCard(sharpMod, places, theme.titleResolved));
      cards.push(outro);
      narration.push("오늘 브리핑 끝. 저장해두고 하나씩 가보세요");
    } catch { /* 아웃트로는 없어도 됨 */ }
    console.log(`카운트다운 카드 ${cards.length}장 생성`);
  } else {
    // classic·dark: 6칸 그리드 단일컷. 배경은 포토코리아 전문가 컷 우선
    // (공공누리 1유형 — 캡션에 크레딧 필수). 스타일 결정은 위(main 초입)에서 완료.
    pkBg = theme.mode === "area" ? null : await photoKoreaPhoto(theme.keyword);
    if (pkBg) console.log(`포토코리아 배경: ${pkBg.title}${pkBg.photographer ? " ⓒ" + pkBg.photographer : ""}`);
    reelCover = await composeReelCover(theme, places, coverStyle === "dark", pkBg?.url);
  }

  if (DRY) {
    if (cdMode) {
      fs.copyFileSync(cards[0], "countdown-intro-preview.jpg");
      if (cards[1]) fs.copyFileSync(cards[1], "countdown-rank-preview.jpg");
      console.log("DRY — countdown-intro-preview.jpg / countdown-rank-preview.jpg 저장");
    } else {
      fs.copyFileSync(reelCover, "roundup-reel-preview.jpg");
      if (STYLE !== "carousel" && coverStyle !== "pages") {
        // 실발행에서 첫 3초에 나갈 훅 컷 — 폰에서 그림으로 확인해야 판단이 된다
        const hook = await buildHookCut(theme, places, pkBg?.url);
        if (hook) {
          fs.copyFileSync(hook, "roundup-hook-preview.jpg");
          console.log("DRY — roundup-hook-preview.jpg 저장 (첫 3초 훅 컷)");
        }
      }
      if (coverStyle === "pages") {
        const stills = await buildPageStills(sharpMod, reelCover, places);
        stills.forEach((st, i) => fs.copyFileSync(st.path, `pages-preview-${String(i + 1).padStart(2, "0")}.jpg`));
        console.log(`DRY — pages-preview-01~${String(stills.length).padStart(2, "0")}.jpg 저장`);
        if (process.env.DRY_RENDER === "1") {
          // 로컬 ffmpeg로 실제 영상까지 (발행 없음) — 컷 이어붙이기·BGM 검증용
          const { pickBgm } = await import("../lib/bgm.ts");
          const total = await renderPagesReel(stills, pickBgm(), "pages-preview.mp4");
          console.log(`DRY — pages-preview.mp4 렌더 (${total}초)`);
        }
      }
      if (STYLE === "carousel") {
        // 실발행과 동일한 전체 장 구성 미리보기 — 표지(4:5 크롭) + 식당 카드들 + 체크리스트
        const pad = (n) => String(n).padStart(2, "0");
        await sharpMod(reelCover).extract({ left: 0, top: 285, width: 1080, height: 1350 })
          .jpeg({ quality: 90 }).toFile("carousel-preview-01-cover.jpg");
        for (let i = 0; i < places.length; i++) {
          fs.writeFileSync(`carousel-preview-${pad(i + 2)}-card.jpg`, await composeCarouselCard(sharpMod, places[i], i + 1));
        }
        const cl = await composeChecklistCard(sharpMod, theme, places);
        await sharpMod(cl).extract({ left: 0, top: 285, width: 1080, height: 1350 })
          .jpeg({ quality: 90 }).toFile(`carousel-preview-${pad(places.length + 2)}-checklist.jpg`);
        console.log(`DRY — carousel-preview-01~${pad(places.length + 2)}.jpg 저장 (실발행과 동일 구성)`);
      }
      // 디자인 시안을 같은 데이터로 비교하려면 수집 결과가 필요하다(재수집하면 식당이 바뀜)
      fs.writeFileSync("roundup-dry-data.json", JSON.stringify({ theme, places }, null, 1));
      console.log("DRY 모드 — 발행 생략. roundup-reel-preview.jpg / roundup-dry-data.json 저장");
    }
    console.log(caption);
    return;
  }

  // 중복발행 방지: 오늘 같은 테마가 이미 발행됐으면 스킵 + 발행 '전에' 마커 선기록.
  const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, ""); // KST
  const cid = `${STYLE === "countdown" ? "countdown" : STYLE === "carousel" ? "carousel" : "roundup"}-${theme.key}-${today}`;
  if (FORCE) {
    // 인스타에서 지운 게시물의 행(ig_media_id 포함)을 치운다 — 지표 크론이 죽은 미디어를 조회하지 않게
    const gone = await db.execute({ sql: "DELETE FROM posts WHERE content_id = ?", args: [cid] });
    console.log(`강제 재발행 — 기존 행 ${gone.rowsAffected}건 삭제: ${cid}`);
  }
  const dup = await db.execute({
    sql: "SELECT 1 FROM posts WHERE content_id = ? AND status IN ('published','publishing')",
    args: [cid],
  });
  if (dup.rows.length) {
    console.log("오늘 이미 발행된 테마 — 스킵:", cid);
    return;
  }
  // 같은 테마가 오늘 실패했었다면 그 행을 치우고 다시 시도 (content_id UNIQUE)
  await db.execute({ sql: "DELETE FROM posts WHERE content_id = ? AND status = 'failed'", args: [cid] });
  await db.execute({
    sql: `INSERT INTO posts (content_id, place_name, address, category, image_url, caption, status, cover_style, title_font)
          VALUES (?, ?, ?, '모음집', ?, ?, 'publishing', ?, ?)`,
    args: [
      cid,
      theme.titleResolved,
      places.map((p, i) => `${i + 1}. ${p.name} — ${p.address}`).join("\n"),
      places[0].imageUrl,
      caption,
      coverStyle,
      titleFont,
    ],
  });
  pending = { db, cid };

  // ===== 캐러셀(주간 저장형 포맷): 표지 4:5 크롭 + 식당별 상세 카드 → 사진집 발행 =====
  if (STYLE === "carousel") {
    const imgs = [];
    const cover45 = path.join(TMP, "car_cover.jpg");
    // 표지는 4:5 안전영역(중앙 1080x1350)에 콘텐츠가 설계돼 있어 크롭이 곧 캐러셀 규격
    await sharpMod(reelCover)
      .extract({ left: 0, top: 285, width: 1080, height: 1350 })
      .jpeg({ quality: 90 })
      .toFile(cover45);
    imgs.push(cover45);
    for (let i = 0; i < places.length; i++) {
      const f = path.join(TMP, `car_${i}.jpg`);
      try {
        fs.writeFileSync(f, await composeCarouselCard(sharpMod, places[i], i + 1));
        imgs.push(f);
      } catch (e) {
        console.error(`카드 ${i + 1} 실패(제외):`, String(e).slice(0, 80));
      }
    }
    if (imgs.length < 4) throw new Error("캐러셀 카드 부족");
    // 마지막 장 = 도장깨기 체크리스트 (저장 유도, 4:5 크롭)
    try {
      const cl = await composeChecklistCard(sharpMod, theme, places);
      const cl45 = path.join(TMP, "car_checklist.jpg");
      await sharpMod(cl).extract({ left: 0, top: 285, width: 1080, height: 1350 }).jpeg({ quality: 90 }).toFile(cl45);
      imgs.push(cl45);
    } catch (e) {
      console.error("체크리스트 장 실패(제외):", String(e).slice(0, 80));
    }
    const urls = [];
    for (const f of imgs) urls.push(await uploadPublic(f));
    let carCaption = caption;
    // 포토코리아 크레딧 라인은 캡션에서 제외 (2026-09-03 사용자 지시)
    const { publishCarousel } = await import("../lib/instagram.ts");
    const mediaId = await publishCarousel(urls, carCaption);
    console.log(`✅ 모음집 캐러셀 발행 (${imgs.length}장):`, mediaId);
    await db.execute({
      sql: `UPDATE posts SET ig_media_id = ?, status = 'published' WHERE content_id = ?`,
      args: [mediaId, cid],
    });
    try {
      const { publishStory } = await import("../lib/instagram.ts");
      console.log("📣 표지 스토리 공유:", await publishStory(await uploadPublic(reelCover)));
    } catch (e) {
      console.error("표지 스토리 실패(무시):", String(e).slice(0, 240));
    }
    const chosenIdx2 = all.findIndex((t) => t.key === theme.key);
    if (chosenIdx2 >= 0) // ROUNDUP_THEME로 슬롯 밖 테마를 강제한 회차는 포인터 유지
    await db.execute({
      sql: "INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))",
      args: [IDX_KEY, String((chosenIdx2 + 1) % all.length)],
    });
    console.log("완료:", theme.titleResolved);
    return;
  }

  const reelMp4 = path.join(TMP, "roundup-reel.mp4");
  // BGM — CC BY 트랙(lib/bgm.ts). 무음 구간이 없어져 이탈이 줄고, 표지만 8초
  // 보여주는 grid 스타일은 특히 BGM이 없으면 방송사고처럼 느껴진다.
  // 인스타 라이브러리 음악(트렌딩) 우선 — FB 경로 설정 시에만. 잡히면 CC BGM은
  // 굽지 않고 발행 시 audio_configuration으로 첨부한다(이중 음악 방지).
  const { pickTrendingAudio } = await import("../lib/igaudio.ts");
  const igMusic = await pickTrendingAudio();
  if (igMusic) console.log("IG 라이브러리 음악:", igMusic.title ?? igMusic.id);
  const { pickBgm } = await import("../lib/bgm.ts");
  const bgm = igMusic ? null : pickBgm();
  if (bgm) console.log("BGM:", bgm.title);
  const ff = (args) =>
    new Promise((resolve, reject) => {
      const p = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "inherit"] });
      p.on("error", reject);
      p.on("close", (c) => (c === 0 ? resolve() : reject(new Error("ffmpeg exit " + c))));
    });

  // 첫 3초 훅 컷 — 그리드(classic·dark) 릴스에만. cdMode(카운트다운·hero)는 이미
  // 인트로 컷이 있고, pages는 표지 4초 뒤 카드가 이어져 훅이 따로 필요 없다.
  const HOOK_SEC = 3;
  const hookApplies = !cdMode && coverStyle !== "pages";
  const hookCut = hookApplies ? await buildHookCut(theme, places, pkBg?.url) : null;
  if (hookApplies && !hookCut) console.error("⚠️ 훅 컷 없이 발행합니다 — 표지 8초 단일컷(reel_format=grid8)");
  // 성과 비교용으로 '무엇이 실제로 나갔는가'를 남긴다 (cover-report가 이 값으로 표본을 가른다)
  const reelFormat = cdMode ? "countdown" : coverStyle === "pages" ? "pages" : hookCut ? "hook3+grid5" : "grid8";

  if (cdMode) {
    // 카드들을 순서대로 이어붙임 (인트로 3초, 순위 카드 2.6초, 아웃트로 2.6초)
    // 나레이션 음성 — TTS는 릴스당 1회만 호출(무료 한도 보호). 실패하면 무음 진행.
    const persona = JSON.parse(
      fs.readFileSync(new URL("../data/persona.json", import.meta.url), "utf8")
    );
    const { ttsPcm, ttsVoiceConfig } = await import("../lib/tts.ts");
    const vc = ttsVoiceConfig(persona);
    let voiceWav = null;
    let voiceDur = 0;
    try {
      const r = await ttsPcm(narration.join("\n"), { voice: vc.voice, direction: vc.direction });
      if (r) {
        const pcm = path.join(TMP, "c_voice.pcm");
        fs.writeFileSync(pcm, r.pcm);
        const wav = path.join(TMP, "c_voice.wav");
        const args = ["-y", "-f", "s16le", "-ar", String(r.rate), "-ac", "1", "-i", pcm];
        const tempo = Math.min(Math.max(vc.speed, 0.5), 2);
        if (Math.abs(tempo - 1) > 0.01) args.push("-filter:a", `atempo=${tempo.toFixed(2)}`);
        args.push(wav);
        await ff(args);
        voiceDur = await probeDuration(wav);
        if (voiceDur > 1) voiceWav = wav;
      }
    } catch (e) {
      console.error("나레이션 생성 실패(무음 진행):", String(e).slice(0, 100));
    }
    console.log(voiceWav ? `나레이션 ${narration.length}문장 (${voiceDur.toFixed(1)}초)` : "나레이션 없음 — 무음");

    // 컷 길이: 음성이 있으면 문장 길이 비율로 배분해 화면과 말이 맞게 함
    const weights = narration.map((s) => Math.max(s.length, 8));
    const wsum = weights.reduce((a, b) => a + b, 0) || 1;

    const clips = [];
    for (let i = 0; i < cards.length; i++) {
      const secs = voiceWav
        ? Math.max((voiceDur * (weights[i] ?? 1)) / wsum, 1.4)
        : i === 0 ? 2.2 : 2.6; // 무음 폴백도 인트로는 짧게
      const out = path.join(TMP, `c_clip_${i}.mp4`);
      const d = Math.round(secs * 30);
      await ff([
        "-y", "-loop", "1", "-i", cards[i], "-t", String(secs.toFixed(2)), "-r", "30",
        "-vf",
        `scale=3240:5760:flags=lanczos,zoompan=z='min(zoom+0.0005,1.10)':d=${d}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1080x1920:fps=30,format=yuv420p`,
        // CRF 18: 기본(23)은 정지 사진+줌에서 뭉개짐이 보였다. 컷은 여기서 한 번만 인코딩하고
        // 아래 concat은 재인코딩 없이 이어 붙인다 (세대 손실 1회 제거)
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", out,
      ]);
      clips.push(out);
    }
    const listFile = path.join(TMP, "c_list.txt");
    fs.writeFileSync(listFile, clips.map((c) => `file '${c}'`).join("\n"));
    const silent = path.join(TMP, "c_silent.mp4");
    await ff([
      "-y", "-f", "concat", "-safe", "0", "-i", listFile,
      "-c", "copy", silent, // 컷들이 같은 인코딩 파라미터라 무손실 병합
    ]);
    const cdSec = await probeDuration(silent);
    const cdFade = cdSec > 2 ? `,afade=t=out:st=${(cdSec - 0.8).toFixed(2)}:d=0.8` : "";
    if (voiceWav && bgm) {
      // 목소리가 주인공 — BGM은 낮게(0.14), 영상 끝 페이드아웃
      await ff([
        "-y", "-i", silent, "-i", voiceWav, "-stream_loop", "-1", "-i", bgm.path,
        "-filter_complex",
        `[1:a]apad[vo];[2:a]volume=0.14[bg];[vo][bg]amix=inputs=2:duration=longest:dropout_transition=0${cdFade}[a]`,
        "-map", "0:v", "-map", "[a]",
        "-c:v", "copy", "-c:a", "aac", "-b:a", "128k", "-shortest", "-movflags", "+faststart", reelMp4,
      ]);
    } else if (voiceWav) {
      await ff([
        "-y", "-i", silent, "-i", voiceWav,
        "-c:v", "copy", "-c:a", "aac", "-b:a", "128k",
        "-movflags", "+faststart", reelMp4,
      ]);
    } else if (bgm) {
      await ff([
        "-y", "-i", silent, "-stream_loop", "-1", "-i", bgm.path,
        "-filter_complex", `[1:a]volume=0.35${cdFade}[a]`,
        "-map", "0:v", "-map", "[a]",
        "-c:v", "copy", "-c:a", "aac", "-b:a", "128k", "-shortest", "-movflags", "+faststart", reelMp4,
      ]);
    } else {
      await ff([
        "-y", "-i", silent,
        "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
        "-c:v", "copy", "-c:a", "aac", "-shortest", "-movflags", "+faststart", reelMp4,
      ]);
    }
    console.log(`카운트다운 릴스 렌더 완료 (${clips.length}컷${voiceWav ? ", 음성 포함" : ""})`);
  } else if (coverStyle === "pages") {
    // 페이지형: classic 표지 4초 → 식당 카드 6장 각 2.5초 (총 ~19초, BGM만, 나레이션 없음)
    const stills = await buildPageStills(sharpMod, reelCover, places);
    const total = await renderPagesReel(stills, bgm, reelMp4);
    console.log(`페이지형 릴스 렌더 완료 (${stills.length}컷, ${total}초)`);
  } else if (hookCut) {
    // 리스트 표지 → 훅 컷 3초 + 그리드 표지 5초 (총 8초, 모션 없음).
    // 8초 단일컷이던 것을 2컷으로 나눈 이유: 평균 시청 4.9초라 그리드를 다 읽기 전에
    // 이탈한다. 첫 3초는 음식 풀샷으로 붙잡고, 정보(6곳 그리드)는 그 뒤에 준다.
    // 장면 전환은 1회뿐 — 줌인 등 모션 금지 규칙은 그대로다.
    // 체크리스트 2컷은 사용자 피드백("너무 이상하다", 2026-09-02)으로 제외 —
    // 체크리스트 카드는 캐러셀 마지막 장에만 남는다.
    const total = await renderPagesReel(
      [{ path: hookCut, sec: HOOK_SEC }, { path: reelCover, sec: 8 - HOOK_SEC }],
      bgm,
      reelMp4
    );
    console.log(`그리드 릴스 렌더 완료 (훅 ${HOOK_SEC}초 + 표지 ${8 - HOOK_SEC}초, ${total}초)`);
  } else {
    // 훅 컷 실패 폴백 — 기존 표지 8초 고정 단일컷.
    // 줌인을 뺀 이유: 정보 카드가 천천히 움직이면 읽는 중에 글자가 흔들려 거슬린다.
    const gridAudio = bgm
      ? ["-stream_loop", "-1", "-i", bgm.path]
      : ["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100"];
    // ⚠️ "-t 8"을 입력 사이에 두면 다음 입력(BGM)에 붙어 버려, 무한 루프 BGM과
    //    -shortest가 만나 렌더가 영원히 안 끝난다(실측 5분 타임아웃). 출력 옵션으로.
    await ff([
      "-y", "-loop", "1", "-i", reelCover,
      ...gridAudio,
      "-filter_complex",
      `[0:v]fps=30,format=yuv420p[v]${bgm ? ";[1:a]volume=0.35,afade=t=out:st=7.2:d=0.8[a]" : ""}`,
      "-map", "[v]", "-map", bgm ? "[a]" : "1:a",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-tune", "stillimage", "-c:a", "aac",
      "-t", "8", "-movflags", "+faststart", reelMp4,
    ]);
  }

  const reelUrl = await uploadPublic(reelMp4);
  console.log("모음집 릴스 업로드:", reelUrl);
  const { publishReelSmart } = await import("../lib/instagram.ts");
  let finalCaption = caption;
  // 포토코리아 크레딧 라인은 캡션에서 제외 (2026-09-03 사용자 지시)
  if (bgm) finalCaption += `
${bgm.attribution}`;
  // countdown은 나레이션이 주인공(음악 30), grid는 음악이 주인공(100)
  const musicOpt = igMusic
    ? { audioId: igMusic.id, audioVolume: cdMode ? 30 : 100, videoVolume: 100 } // 나레이션 있는 형식은 음악을 낮게
    : null;
  // 프로필 그리드 썸네일 — 훅 컷을 붙인 회차는 0프레임이 음식 풀샷이라, 정보가 담긴
  // 그리드 표지 구간(훅 다음 1초 지점)을 커버로 지정한다.
  const thumbMs = hookCut ? (HOOK_SEC + 1) * 1000 : 0;
  let mediaId;
  try {
    mediaId = await publishReelSmart(reelUrl, finalCaption, musicOpt, { thumbOffsetMs: thumbMs });
  } catch (e) {
    // 인스타가 사유 없이 컨테이너 ERROR를 주는 경우(9/3 성수 편 실측). 같은 규격의 영상이
    // 전날은 정상 발행됐으니 호스트에서 영상을 못 받아온 일시 오류일 가능성이 크다 —
    // 다른 호스트로 다시 올려 한 번 더. (영상 재렌더는 안 함: 문제는 URL 쪽)
    if (!/컨테이너 처리 실패|컨테이너 처리 시간 초과/.test(String(e))) throw e;
    console.error("[publish] 컨테이너 ERROR — 다른 호스트로 재업로드 후 1회 재시도:", String(e).slice(0, 160));
    await new Promise((r) => setTimeout(r, 20000));
    const retryUrl = await uploadPublic(reelMp4, { avoidHostOf: reelUrl });
    console.log("모음집 릴스 재업로드:", retryUrl);
    // 마지막 시도는 커버 프레임 지정 없이 — 커버 하나 때문에 그날 콘텐츠를 통째로 잃지 않는다
    mediaId = await publishReelSmart(retryUrl, finalCaption, musicOpt, { thumbOffsetMs: 0 });
  }
  console.log("✅ 모음집 릴스 발행:", mediaId);
  await db.execute({
    sql: `UPDATE posts SET ig_media_id = ?, status = 'published', reel_format = ? WHERE content_id = ?`,
    args: [mediaId, reelFormat, cid],
  });

  // 발행 직후 표지를 스토리로도 공유 — 팔로워 재도달 + 프로필 방문 루프.
  // (표지는 이미 9:16이라 그대로 스토리 규격. 실패해도 본 발행에는 영향 없음)
  try {
    const coverJpg = reelCover ?? cards[0];
    if (coverJpg) {
      const { publishStory } = await import("../lib/instagram.ts");
      const storyUrl = await uploadPublic(coverJpg);
      const storyId = await publishStory(storyUrl);
      console.log("📣 표지 스토리 공유:", storyId);
    }
  } catch (e) {
    console.error("표지 스토리 실패(무시):", String(e).slice(0, 240));
  }

  // 표지 스타일 포인터 이동 — 3안이 같은 횟수만큼 나가야 비교가 된다.
  // (수동 지정 COVER_STYLE로 돌린 회차는 표본을 흔들지 않도록 포인터를 건드리지 않는다)
  if (STYLE === "grid" && coverStyle && !process.env.COVER_STYLE) {
    const ci = await db.execute("SELECT value FROM config WHERE key = 'cover_idx'");
    // 주기는 배열 길이를 따른다 — 7로 하드코딩돼 있어 배열을 바꾸면 순환이 어긋났다
    const next = ((ci.rows.length ? Number(ci.rows[0].value) : 0) + 1) % COVER_STYLES.length;
    await db.execute({
      sql: "INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))",
      args: ["cover_idx", String(next)],
    });
  }

  // 서체 A/B 포인터 이동 — 두 서체가 같은 횟수만큼 나가야 비교가 된다.
  if (STYLE === "grid" && !manualFont) {
    const fi = await db.execute("SELECT value FROM config WHERE key = 'font_idx'");
    await db.execute({
      sql: "INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))",
      args: ["font_idx", String(((fi.rows.length ? Number(fi.rows[0].value) : 0) + 1) % 2)],
    });
  }

  // 포인터 이동 (계절 스킵돼도 로테이션 유지)
  const chosenIdx = all.findIndex((t) => t.key === theme.key);
  if (chosenIdx >= 0) // ROUNDUP_THEME로 슬롯 밖 테마를 강제한 회차는 포인터 유지
  await db.execute({
    sql: "INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))",
    args: [IDX_KEY, String((chosenIdx + 1) % all.length)],
  });

  console.log("완료:", theme.titleResolved);
}

/** 미디어 길이(초) — ffprobe. 실패하면 0 */
function probeDuration(file) {
  return new Promise((resolve) => {
    const p = spawn("ffprobe", [
      "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file,
    ]);
    let out = "";
    p.on("error", () => resolve(0));
    p.stdout.on("data", (d) => (out += d));
    p.on("close", () => resolve(Number(String(out).trim()) || 0));
  });
}

function curlUpload(args) {
  return new Promise((resolve, reject) => {
    const p = spawn("curl", ["-s", "--max-time", "120", ...args]);
    p.on("error", reject); // spawn 실패 시 Promise가 안 끝나는 것 방지
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("close", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`curl exit ${code}`))));
  });
}

/** 공개 URL 업로드 폴백 체인 (Blob → tmpfiles → catbox) */
async function uploadPublic(filePath, { avoidHostOf = "" } = {}) {
  // avoidHostOf: 직전에 쓴 URL — 그 호스트(tmpfiles 등)는 건너뛰고 다음 폴백으로 (재시도용)
  const avoid = (host) => avoidHostOf.includes(host);
  if (process.env.BLOB_READ_WRITE_TOKEN && !avoid("blob.vercel-storage.com")) {
    try {
      const { put } = await import("@vercel/blob");
      const res = await put(`roundups/${Date.now()}-${path.basename(filePath)}`, fs.readFileSync(filePath), {
        access: "public", contentType: "image/jpeg", token: process.env.BLOB_READ_WRITE_TOKEN,
      });
      return res.url;
    } catch (e) {
      console.error("Vercel Blob 실패, 다음 폴백:", String(e).slice(0, 150));
    }
  }
  if (!avoid("tmpfiles.org")) try {
    const out = await curlUpload(["-F", `file=@${filePath}`, "https://tmpfiles.org/api/v1/upload"]);
    const pageUrl = JSON.parse(out)?.data?.url?.replace("tmpfiles.org/", "tmpfiles.org/dl/");
    if (pageUrl) {
      const html = await fetch(pageUrl, { signal: AbortSignal.timeout(20000) }).then((r) => r.text());
      const m = html.match(/href="(https:\/\/tmpfiles\.org\/dl\/[^"]+\.(?:jpg|jpeg|png|mp4))"/);
      if (m) return m[1];
    }
  } catch (e) {
    console.error("tmpfiles 실패, 다음 폴백:", String(e).slice(0, 150));
  }
  const out = await curlUpload([
    "-F", "reqtype=fileupload", "-F", "userhash=", "-F", `fileToUpload=@${filePath}`,
    "https://catbox.moe/user/api.php",
  ]);
  if (out.startsWith("http")) return out;
  throw new Error("모든 업로드 실패: " + out.slice(0, 200));
}

// 러너 타임아웃·취소는 SIGTERM으로 온다 — catch를 못 타므로 여기서 pending 행을 failed로
process.on("SIGTERM", async () => {
  if (pending) {
    try {
      await pending.db.execute({ sql: "UPDATE posts SET status = 'failed' WHERE content_id = ? AND status = 'publishing'", args: [pending.cid] });
      console.error("SIGTERM — posts 행을 failed로 표시:", pending.cid);
    } catch { /* 무시 */ }
  }
  process.exit(1);
});

main()
  .then(() => process.exit(0))
  .catch(async (e) => {
    console.error("모음집 실패:", e);
    if (pending) {
      try {
        await pending.db.execute({
          sql: "UPDATE posts SET status = 'failed' WHERE content_id = ? AND status = 'publishing'",
          args: [pending.cid],
        });
        console.error("posts 행을 failed로 표시:", pending.cid);
      } catch (e2) {
        console.error("failed 표시 실패:", String(e2).slice(0, 120));
      }
    }
    process.exit(1);
  });
