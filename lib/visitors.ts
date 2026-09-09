// 한국관광공사_빅데이터_지역별 방문자수 (data.go.kr 15101972) — 시군구별 실제 방문자 수.
// KT(내국인)·SKT(외국인) 이동통신 기반, 매월 17일에 전월분 갱신, 무료.
// TOUR_API_KEY와 같은 data.go.kr 인증키를 쓰지만 **해당 데이터셋 활용신청이 따로 필요**하다.
//
// 왜 붙였나: 테마 가중치가 "이미 발행해서 조회수를 기록한 테마"로만 매겨져서, 안 해본
// 테마는 전부 같은 값(2.0)이었다. 2026-09-08 실측 로그에서 상권 47개 중 45개가 '미시도'였다.
// 그런데 조회수는 지역 인지도를 그대로 따라간다(성수 857 > 춘천 247 > 대전 유성 95).
// 즉 한 번 태워봐야만 아는 구조였는데, 방문자 수는 그걸 **사전에** 알려준다.
//
// ⚠️ 응답 스키마를 문서로 확인하지 못했다(작업 세션에서 data.go.kr 접근이 막혀 있었다).
//    그래서 파서를 필드명 패턴으로 관대하게 짰고, 경로는 env로 바꿀 수 있게 뒀다.
//    실물 확인은 `scripts/probe-visitors.mjs`(러너에서 실행)로 한다.
//    무엇이 됐든 실패하면 null을 돌려 기존 동작(평탄한 가중치)으로 돌아간다.
//
// ⚠️ 시군구는 **이름만으로 식별되지 않는다** — 중구·동구·서구·남구·북구는 여러 시에 있다.
//    (대전 중구 / 부산 중구 / 대구 중구 …) 그래서 시도+시군구 쌍으로 맞추고,
//    시도를 확정할 수 없어 후보가 둘 이상이면 **그 테마는 가중치를 주지 않는다**.
//    잘못 붙은 가중치는 조용히 틀린 선택을 만들고 나중에 원인을 찾을 수 없다.

import { db } from "./db";

const BASE = "https://apis.data.go.kr/B551011";
// 운영 경로가 확실하지 않아 후보를 순서대로 시도한다. 프로브로 확정되면 VISITOR_API_PATH로 고정.
const PATH_CANDIDATES = [
  "DataLabService/metcoRegnVisitrDDList",
  "DataLabService/locgoRegnVisitrDDList",
  "TatsCnctrRateService/tatsCnctrRatedList",
];

const CACHE_KEY = "visitor_stats_v2"; // v1은 시군구 이름만 저장해 오매칭 위험이 있었다
// 실패도 캐시한다. 데이터셋 미승인 상태면 경로 3 x 월 3 x 20초 = 최대 180초를
// **매 발행마다** 임계경로에서 버린다(검토 실측 180.1초). 발행이 늦어질 이유가 없다.
const FAIL_KEY = "visitor_stats_fail";
const FAIL_RETRY_HOURS = 72;
const SGG_CACHE_KEY = "theme_sgg_v2";
const CACHE_DAYS = 30; // 월 1회 갱신 데이터

/** "시도|시군구" → 방문자 수. 시도를 못 얻은 행은 "|시군구". */
export type VisitorStats = Record<string, number>;
export interface Region { sido: string; sgg: string; failedAt?: string }

// 카카오가 잠깐 죽은 것뿐인데 실패를 영원히 캐시하면 그 테마는 다시는 가중치를
// 못 받는다. 실패는 날짜와 함께 저장하고 이 기간이 지나면 다시 시도한다.
const RESOLVE_RETRY_DAYS = 7;

// ===== 지역명 정규화 =====
// 카카오는 "대전광역시/유성구", 관광 데이터는 "대전/유성구"처럼 표기가 갈린다.
const SIDO_SHORT: Record<string, string> = {
  서울특별시: "서울", 부산광역시: "부산", 대구광역시: "대구", 인천광역시: "인천",
  광주광역시: "광주", 대전광역시: "대전", 울산광역시: "울산",
  세종특별자치시: "세종", 세종시: "세종",
  경기도: "경기", 강원도: "강원", 강원특별자치도: "강원",
  충청북도: "충북", 충청남도: "충남", 전라북도: "전북", 전북특별자치도: "전북",
  전라남도: "전남", 경상북도: "경북", 경상남도: "경남",
  제주도: "제주", 제주특별자치도: "제주",
};

export function normSido(raw: string | null | undefined): string {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  if (SIDO_SHORT[s]) return SIDO_SHORT[s];
  // 이미 짧은 형태거나 접미사만 붙은 경우
  for (const [long, short] of Object.entries(SIDO_SHORT)) {
    if (s === short || long.startsWith(s) || s.startsWith(short)) return short;
  }
  return s;
}

/** "창원시 성산구" 같은 2단 시군구는 그대로 두되, 앞 시(市)만 쓰는 데이터도 있어 후보를 함께 낸다 */
export function sggCandidates(raw: string | null | undefined): string[] {
  const s = String(raw ?? "").trim().replace(/\s+/g, " ");
  if (!s) return [];
  const out = [s];
  const parts = s.split(" ");
  if (parts.length > 1) out.push(parts[0], parts[parts.length - 1]);
  return [...new Set(out)];
}

const keyOf = (sido: string, sgg: string) => `${sido}|${sgg}`;

/**
 * 법정동 코드 앞 2자리 → 시도(짧은 이름). 시군구 방문자 응답이 시도 이름을 안 주기 때문에
 * 이걸로 복원한다. 42/51(강원), 45/52(전북)은 특별자치도 전환 전후 코드가 함께 쓰인다.
 */
const SIDO_BY_CODE: Record<string, string> = {
  "11": "서울", "26": "부산", "27": "대구", "28": "인천", "29": "광주",
  "30": "대전", "31": "울산", "36": "세종", "41": "경기",
  "42": "강원", "51": "강원", "43": "충북", "44": "충남",
  "45": "전북", "52": "전북", "46": "전남", "47": "경북", "48": "경남", "50": "제주",
};

/**
 * 여러 시도에 같은 이름으로 존재하는 시군구.
 * 응답에 시도 필드가 없으면 이 이름들은 한 칸에 합쳐져 버려서 어느 도시 값인지
 * 알 수 없다 — 그때는 값을 주지 않는다(찍으면 조용히 틀린다).
 * 고성군은 강원·경남 둘 다, 나머지 구들은 광역시 여러 곳에 있다.
 */
const AMBIGUOUS_SGG = new Set([
  "중구", "동구", "서구", "남구", "북구", "강서구", "고성군",
]);

/** data.go.kr 응답 어디에 있든 item 배열을 찾아낸다 (JSON/래핑 형태가 서비스마다 다르다) */
function findItems(json: any): any[] {
  const seen = new Set<any>();
  const walk = (node: any, depth: number): any[] | null => {
    if (!node || typeof node !== "object" || depth > 6 || seen.has(node)) return null;
    seen.add(node);
    if (Array.isArray(node)) return node.length && typeof node[0] === "object" ? node : null;
    if (node.item) return Array.isArray(node.item) ? node.item : [node.item];
    for (const v of Object.values(node)) {
      const hit = walk(v, depth + 1);
      if (hit) return hit;
    }
    return null;
  };
  return walk(json, 0) ?? [];
}

const pick = (row: any, re: RegExp): string | null => {
  for (const [k, v] of Object.entries(row)) {
    if (re.test(k) && v != null && String(v) !== "") return String(v);
  }
  return null;
};

/**
 * 한 행에서 (시도, 시군구, 방문자수)를 뽑는다. 필드명이 서비스마다 달라 패턴으로 찾는다.
 * 시군구 필드가 없으면 null — 광역 단위 행은 상권 비교에 쓸 수 없다.
 */
export function parseRow(row: any): { sido: string; sgg: string; n: number } | null {
  const sggRaw = pick(row, /signgu.*nm|sgng.*nm|시군구/i);
  const sidoRaw = pick(row, /^(?!.*signgu)(?!.*sgng).*(area.*nm|metco.*nm|sido.*nm|시도)/i);
  const raw = pick(row, /touNum|visit|방문/i);
  if (!sggRaw || raw == null) return null;
  const n = Number(String(raw).replace(/[^\d.]/g, ""));
  if (!Number.isFinite(n) || n <= 0) return null;
  // 실측(2026-09-09, 승인 후): 시군구 응답에는 시도 이름이 아예 없고 `signguCode`만 온다
  // ({"signguCode":"11110","signguNm":"종로구",...}). 그대로 두면 중구·동구처럼 여러 시도에
  // 있는 이름이 한 칸에 합쳐져 행 수가 불균일해지고(실측 27~540) 통계 전체가 폐기된다.
  // 법정동 코드 앞 2자리로 시도를 복원한다.
  let sido = normSido(sidoRaw);
  if (!sido) {
    const code = pick(row, /signgu.*c(o)?de|sgng.*c(o)?de|시군구.*코드/i);
    if (code) sido = SIDO_BY_CODE[String(code).trim().slice(0, 2)] ?? "";
  }
  return { sido, sgg: String(sggRaw).trim(), n };
}

/** 그 달의 마지막 날 — `${ym}31`을 넣으면 30일 달·2월 조회가 거부될 수 있다 */
function lastDay(ym: string): string {
  const y = Number(ym.slice(0, 4)), m = Number(ym.slice(4, 6));
  return String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0");
}

/** 전월(데이터가 아직 없을 수 있어 두 달 전까지 되짚는다) YYYYMM 목록 */
function recentMonths(): string[] {
  const out: string[] = [];
  const d = new Date();
  for (let i = 1; i <= 3; i++) {
    const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1));
    out.push(`${m.getUTCFullYear()}${String(m.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}

const PAGE = 1000;
const MAX_PAGES = 40; // 1000행 x 40 = 4만 행이면 시군구 229개 x 한 달 x 구분 몇 종을 덮는다

async function fetchPage(path: string, ym: string, pageNo: number): Promise<any | null> {
  const key = process.env.TOUR_API_KEY;
  if (!key) return null;
  const qs = new URLSearchParams({
    serviceKey: decodeURIComponent(key),
    MobileOS: "ETC",
    MobileApp: "insta-spot-bot",
    _type: "json",
    numOfRows: String(PAGE),
    pageNo: String(pageNo),
    startYmd: `${ym}01`,
    endYmd: `${ym}${lastDay(ym)}`,
  });
  const res = await fetch(`${BASE}/${path}?${qs}`, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) return null;
  const text = await res.text();
  // 인증 실패·미신청은 XML 에러로 온다 — JSON 파싱 전에 걸러 로그를 남긴다
  if (!text.trim().startsWith("{")) {
    const reason = text.match(/<returnAuthMsg>([^<]*)</)?.[1] ?? text.slice(0, 120);
    console.error(`[visitors] ${path} 비JSON 응답: ${reason}`);
    return null;
  }
  return JSON.parse(text);
}

/**
 * 한 달치를 **전부** 받아 시군구별로 합산한다.
 *
 * ⚠️ 한 페이지만 받으면 안 된다. 경로 후보가 전부 일자별(DDList)이라 응답이
 *    시군구 x 일자 x 방문자구분으로 늘어나는데, 1000행만 받으면 합계가
 *    "그 시군구가 앞쪽 1000행에 몇 번 실렸는가"가 된다 — 방문자 규모가 아니라
 *    API 정렬 순서가 테마 확률을 정하게 된다(검토 확정, 2026-09-09).
 *    그래서 totalCount를 보고 끝까지 받고, 못 받으면 **버린다**.
 */
async function callOnce(path: string, ym: string): Promise<VisitorStats | null> {
  const stats: VisitorStats = {};
  const rowCount: Record<string, number> = {};
  const deadline = Date.now() + 60_000; // 발행 경로라 예산을 둔다(30일 캐시라 월 1회)
  let seen = 0;
  let total = Infinity;

  for (let page = 1; page <= MAX_PAGES; page++) {
    if (page > 1 && Date.now() > deadline) break;
    const json = await fetchPage(path, ym, page);
    if (!json) return null;
    const tc = Number(json?.response?.body?.totalCount);
    if (Number.isFinite(tc) && tc > 0) total = tc;
    const items = findItems(json);
    if (!items.length) break;
    seen += items.length;
    for (const row of items) {
      const r = parseRow(row);
      if (!r) continue;
      // 같은 시군구의 일자별·구분별 행을 합산 = 그 달의 총량. 아래 균일성 검사가
      // '어떤 시군구만 행이 더 많은' 절단 상태를 걸러 준다.
      const k = keyOf(r.sido, r.sgg);
      stats[k] = (stats[k] ?? 0) + r.n;
      rowCount[k] = (rowCount[k] ?? 0) + 1;
    }
    if (seen >= total || items.length < PAGE) break;
  }

  if (seen < total) {
    console.error(`[visitors] ${path} ${ym} 부분 응답 ${seen}/${total} — 합계가 왜곡되므로 폐기`);
    return null;
  }
  // 스키마를 몰라도 쓸 수 있는 방어선: 시군구별 행 수가 고르지 않으면 커버리지가 깨진 것.
  // (전 지역이 같은 일수·같은 구분 수만큼 나와야 합계가 서로 비교 가능하다)
  const counts = Object.values(rowCount);
  if (counts.length) {
    const lo = Math.min(...counts), hi = Math.max(...counts);
    if (hi > lo * 1.5) {
      console.error(`[visitors] ${path} ${ym} 시군구별 행 수 불균일(${lo}~${hi}) — 비교 불가로 폐기`);
      return null;
    }
  }
  return Object.keys(stats).length >= 10 ? stats : null; // 너무 적으면 파싱 실패로 본다
}

/**
 * 시군구별 방문자 수. 30일 캐시(월 1회 갱신 데이터라 매 발행마다 부를 이유가 없다).
 * 키 없음·미신청·스키마 불일치 등 어떤 이유로든 실패하면 null → 호출부는 기존 동작 유지.
 */
export async function fetchVisitorStats(): Promise<VisitorStats | null> {
  try {
    const cached = await db.execute({
      sql: "SELECT value, updated_at FROM config WHERE key = ?",
      args: [CACHE_KEY],
    });
    if (cached.rows.length) {
      const age =
        Date.now() -
        new Date(String(cached.rows[0].updated_at).replace(" ", "T") + "Z").getTime();
      if (age < CACHE_DAYS * 86_400_000) {
        const v = JSON.parse(String(cached.rows[0].value));
        if (v && Object.keys(v).length) return v;
      }
    }
  } catch { /* 캐시 실패는 무시하고 새로 받는다 */ }

  // 최근에 실패했으면 다시 시도하지 않는다 — 미승인 데이터셋에 매 발행 180초를 쓰지 않게
  try {
    const f = await db.execute({
      sql: "SELECT updated_at FROM config WHERE key = ?",
      args: [FAIL_KEY],
    });
    if (f.rows.length) {
      const age =
        Date.now() - new Date(String(f.rows[0].updated_at).replace(" ", "T") + "Z").getTime();
      if (age < FAIL_RETRY_HOURS * 3_600_000) {
        console.log(
          `[visitors] 최근 조회 실패 기록 있음 — ${FAIL_RETRY_HOURS}시간 뒤 재시도(사전 가중치 생략)`
        );
        return null;
      }
    }
  } catch { /* 기록 없음 — 그냥 진행 */ }

  const paths = process.env.VISITOR_API_PATH ? [process.env.VISITOR_API_PATH] : PATH_CANDIDATES;
  for (const path of paths) {
    for (const ym of recentMonths()) {
      try {
        const stats = await callOnce(path, ym);
        if (!stats) continue;
        const withSido = Object.keys(stats).filter((k) => !k.startsWith("|")).length;
        console.log(
          `[visitors] ${path} ${ym} — 시군구 ${Object.keys(stats).length}개 (시도 확인 ${withSido}개)`
        );
        try {
          await db.execute({
            sql: "INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))",
            args: [CACHE_KEY, JSON.stringify(stats)],
          });
          await db.execute({ sql: "DELETE FROM config WHERE key = ?", args: [FAIL_KEY] });
        } catch { /* 캐시 저장 실패는 무시 */ }
        return stats;
      } catch (e) {
        console.error(`[visitors] ${path} ${ym} 실패:`, String(e).slice(0, 100));
      }
    }
  }
  // 전부 실패 — 다음 발행이 같은 시간을 또 버리지 않게 기록해 둔다
  try {
    await db.execute({
      sql: "INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))",
      args: [FAIL_KEY, "1"],
    });
  } catch { /* 기록 실패는 무시 */ }
  return null;
}

/** 프로브가 캐시를 지우고 실제 호출을 강제할 때 쓴다(수정한 파서를 바로 확인하려고) */
export async function clearVisitorCache(): Promise<void> {
  for (const k of [CACHE_KEY, FAIL_KEY]) {
    try {
      await db.execute({ sql: "DELETE FROM config WHERE key = ?", args: [k] });
    } catch { /* 무시 */ }
  }
}

/**
 * (시도, 시군구) → 방문자 수. **모호하면 null**.
 *
 * 시도를 아는 경우: 정확히 그 시도의 시군구만 본다.
 * 시도를 모르는 경우(또는 데이터에 시도가 없는 경우): 같은 시군구 이름을 가진 후보가
 * 둘 이상이면 null을 돌린다 — "중구"를 아무 도시에나 붙이면 조용히 틀린다.
 */
export function lookupVisitors(stats: VisitorStats, region: Region): number | null {
  const cands = sggCandidates(region.sgg);
  if (!cands.length) return null;
  const entries = Object.entries(stats).map(([k, v]) => {
    const i = k.indexOf("|");
    return { sido: k.slice(0, i), sgg: k.slice(i + 1), v };
  });
  for (const c of cands) {
    const same = entries.filter((e) => e.sgg === c);
    if (!same.length) continue;

    // 데이터 자체에 시도가 없는 행 — 전국의 동명 시군구가 한 칸에 합쳐져 있다.
    // "응답 안에서 유일하다"는 건 "내가 찾는 그 도시다"라는 뜻이 아니다.
    const noSido = same.filter((e) => !e.sido);
    if (noSido.length && AMBIGUOUS_SGG.has(c)) return null;

    if (region.sido) {
      const exact = same.filter((e) => e.sido === region.sido);
      if (exact.length === 1) return exact[0].v;
      if (exact.length > 1) return null; // 같은 시도에 동명 — 판단 불가
      // 시도 표기가 없는 데이터라면, 모호하지 않은 이름에 한해 인정
      if (same.length === 1 && noSido.length === 1) return noSido[0].v;
      continue;
    }
    // 테마 쪽 시도를 모르는 경우 — 후보가 하나이고 모호하지 않을 때만
    if (same.length === 1) return same[0].v;
    return null;
  }
  return null;
}

// ===== 테마 → 시군구 해석 =====
// 방문자 데이터는 시군구 단위라 테마를 시군구에 붙여야 한다. 손으로 68개를 적으면
// 틀리기 쉬워서, 이미 쓰고 있는 카카오 로컬 API로 좌표·지명에서 뽑는다.
//   상권 테마: mapX/mapY → coord2regioncode → (시도, 시군구)
//   도시 테마: keyword → search/address → (시도, 시군구)
// 결과는 config에 영구 캐시한다(테마 좌표가 바뀌지 않는 한 다시 부를 이유가 없다).

async function kakao(path: string, params: Record<string, string>): Promise<any | null> {
  const key = process.env.KAKAO_REST_KEY;
  if (!key) return null;
  const res = await fetch(`https://dapi.kakao.com/v2/local/${path}?${new URLSearchParams(params)}`, {
    headers: { Authorization: `KakaoAK ${key}` },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) return null;
  return res.json();
}

/**
 * 카카오 결과를 테마가 이미 아는 시도와 대조한다.
 * data/roundup-themes.json의 area 테마 68개는 전부 region("강원"·"경남"…)을 갖고 있다.
 * 카카오가 다른 시도를 가리키면 그건 동명 지명을 잘못 잡은 것이다 — 그럴듯하게 틀린
 * 쌍({부산, 연제구})을 만들면 시도 대조 가드가 무의미해지므로 버린다.
 */
function verify(r: Region | null, themeSido: string, key: string): Region | null {
  if (!r?.sgg) return null;
  if (!themeSido) return r;
  if (!r.sido) return { ...r, sido: themeSido }; // 카카오가 시도를 안 준 경우만 보완
  if (r.sido !== themeSido) {
    console.error(`[visitors] ${key}: 카카오 ${r.sido} ${r.sgg} ≠ 테마 ${themeSido} — 동명 지명 오인으로 보고 버림`);
    return null;
  }
  return r;
}

function toRegion(d: any): Region | null {
  const sido = normSido(d?.region_1depth_name);
  // 세종은 시군구가 비어 있는 단층제 — 시도명을 그대로 쓴다
  const sgg = String(d?.region_2depth_name ?? "").trim() || sido;
  return sido || sgg ? { sido, sgg } : null;
}

async function regionOf(theme: any): Promise<Region | null> {
  // 테마 파일에 이미 시도가 있다(예: {"region":"강원"}). 카카오가 시도를 못 주거나
  // 아예 실패해도 이걸로 채우면 동명 시군구를 가르는 데 쓸 수 있다.
  const themeSido = normSido(theme?.region);
  try {
    const t = theme.tour ?? {};
    if (t.mapX && t.mapY) {
      const j = await kakao("geo/coord2regioncode.json", { x: String(t.mapX), y: String(t.mapY) });
      const d = (j?.documents ?? []).find((x: any) => x.region_type === "B") ?? j?.documents?.[0];
      return verify(d ? toRegion(d) : null, themeSido, theme.key);
    }
    if (theme.keyword) {
      const j = await kakao("search/address.json", { query: String(theme.keyword), size: "1" });
      const d = j?.documents?.[0]?.address ?? j?.documents?.[0]?.road_address;
      return verify(d ? toRegion(d) : null, themeSido, theme.key);
    }
  } catch { /* 개별 실패는 null */ }
  return null;
}

/**
 * 테마키 → (시도, 시군구). 캐시에 없는 테마만 카카오로 조회하고 결과를 합쳐 저장한다.
 * 카카오 키가 없거나 전부 실패하면 빈 객체 — 호출부는 기존 동작 유지.
 */
export async function resolveThemeRegions(themes: any[]): Promise<Record<string, Region>> {
  let map: Record<string, Region> = {};
  try {
    const c = await db.execute({ sql: "SELECT value FROM config WHERE key = ?", args: [SGG_CACHE_KEY] });
    if (c.rows.length) map = JSON.parse(String(c.rows[0].value)) ?? {};
  } catch { /* 캐시 없음 */ }

  const stale = (r: Region | undefined) => {
    if (!r) return true;
    if (r.sgg) return false; // 이미 해석됨
    if (!r.failedAt) return true; // 예전 형식(실패 기록에 날짜 없음) — 다시 시도
    return Date.now() - new Date(r.failedAt).getTime() > RESOLVE_RETRY_DAYS * 86_400_000;
  };
  const missing = themes.filter((t) => stale(map[t.key]));
  if (!missing.length) return map;

  // 첫 실행에 68개를 다 부르면 발행이 그만큼 늦어진다 — 시간 예산을 두고 남은 건 다음 회차에.
  const deadline = Date.now() + 20_000;
  let added = 0, retried = 0;
  for (const t of missing) {
    if (Date.now() > deadline) break;
    const r = await regionOf(t);
    // 실패도 기록해 매 회차 다시 부르지는 않되, 날짜를 남겨 일정 기간 뒤 재시도한다
    map[t.key] = r ?? { sido: "", sgg: "", failedAt: new Date().toISOString() };
    if (r?.sgg) added++; else retried++;
  }
  if (added || retried) {
    const ok = Object.values(map).filter((r) => r?.sgg).length;
    console.log(`[visitors] 지역 해석 +${added}곳 (누적 ${ok}${retried ? `, 실패 ${retried}곳은 ${RESOLVE_RETRY_DAYS}일 뒤 재시도` : ""})`);
    try {
      await db.execute({
        sql: "INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))",
        args: [SGG_CACHE_KEY, JSON.stringify(map)],
      });
    } catch { /* 저장 실패는 무시 */ }
  }
  return map;
}
