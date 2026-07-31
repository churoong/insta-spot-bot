// 한국관광공사 TourAPI (KorService2) — 사진·정보의 합법적 출처.
// 공공데이터포털 이용약관상 출처 표기("한국관광공사") 조건으로 자유 이용 가능.

import { geminiText } from "./llm";

const BASE = "https://apis.data.go.kr/B551011/KorService2";

// 39=음식점. 맛집 전문 계정 — 관광지(12)는 제외(2026-07 사용자 결정).
const CONTENT_TYPES = [39];
// 지역 가중치: 대도시·관광·미식 관심이 높은 곳에 더 자주 배정(인지도 높은 식당·수요 집중).
// 전국 다양성은 유지하되 서울·부산·제주·경기 등을 더 자주 뽑음.
// (1서울 2인천 3대전 4대구 5광주 6부산 7울산 8세종 31경기 32강원 33충북 34충남 35경북 36경남 37전북 38전남 39제주)
const AREA_CODES = [
  1, 1, 1, 1, // 서울
  6, 6, 6, // 부산
  39, 39, 39, // 제주
  31, 31, // 경기
  2, 2, // 인천
  4, 4, // 대구
  3, 5, 7, // 대전 광주 울산
  32, 33, 34, 35, 36, 37, 38, // 각 도 1회
  8, // 세종
];

export interface Spot {
  contentId: string;
  name: string;
  address: string;
  category: string; // "맛집" | "여행지"
  imageUrl: string; // 대표 이미지(썸네일)
  imageUrls: string[]; // 캐러셀용 전체 이미지 (대표 포함, 최대 10장)
  overview: string;
  mapx?: string; // 경도 (근처 추천용)
  mapy?: string; // 위도
}

export interface NearbySpot {
  name: string;
  address: string;
  category: string;
  distM: number; // 미터
}

// 인스타 캐러셀 제약: 2~10장. 게시물당 최소 이 장수는 확보(부족하면 후보 건너뜀).
export const MIN_IMAGES = 3;
export const MAX_IMAGES = 10;

function toHttps(u: string): string {
  return String(u).replace(/^http:/, "https:");
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

async function call(endpoint: string, params: Record<string, string>) {
  const qs = new URLSearchParams({
    serviceKey: process.env.TOUR_API_KEY!,
    MobileOS: "ETC",
    MobileApp: "instaSpotBot",
    _type: "json",
    ...params,
  });
  const res = await fetch(`${BASE}/${endpoint}?${qs}`, {
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`TourAPI ${endpoint} HTTP ${res.status}`);
  const json = await res.json();
  const items = json?.response?.body?.items?.item;
  return Array.isArray(items) ? items : items ? [items] : [];
}

/**
 * 대표 이미지가 있는 장소 후보 목록.
 * - 지역은 가중 랜덤(대도시·미식 지역 우선), 유형은 맛집 비중 높게.
 * - 검증된 맛집 + 숨은 맛집을 함께 노출하려고 정렬을 매번 섞음:
 *   Q(최근 수정순)=TourAPI가 관리하는 알려진 곳 / R(생성일순)=덜 알려진 신규·숨은 곳.
 * - firstimage2(2번째 대표사진)가 있는 곳 = 사진이 여러 장인 잘 문서화된 곳을 앞으로.
 *   같은 등급 안에서는 셔플해 다양성 유지. (호출부는 이 순서대로 골라 씀)
 */
export async function fetchCandidates(): Promise<Spot[]> {
  const contentTypeId = pick(CONTENT_TYPES);
  const areaCode = pick(AREA_CODES);
  // 알려진 곳(Q)과 숨은 곳(R)을 반반 섞어, 인증맛집(featured) 외에 숨은 맛집도 꾸준히 발굴.
  const arrange = Math.random() < 0.5 ? "Q" : "R";
  // 페이지를 깊이 탐색해 상위권 소진 시에도 새 후보 발굴.
  // 유명 우선(Q)은 상단(1~2p)에서 품질 유지, 숨은 발굴(R)은 더 깊이(1~4p)까지.
  const pageNo = arrange === "Q" ? pick([1, 1, 2]) : pick([1, 2, 3, 4]);
  const items = await call("areaBasedList2", {
    contentTypeId: String(contentTypeId),
    areaCode: String(areaCode),
    arrange,
    numOfRows: "100",
    pageNo: String(pageNo),
  });
  return rankFoodItems(items, contentTypeId === 39 ? "맛집" : "여행지");
}

// 유명 음식 키워드 — 그 음식으로 이름난 집을 정조준해 발굴(searchKeyword2).
export const FOOD_KEYWORDS = [
  "돼지국밥", "순대국밥", "평양냉면", "함흥냉면", "밀면", "막국수", "칼국수", "콩국수",
  "물회", "곰탕", "설렁탕", "갈비탕", "삼계탕", "추어탕", "해장국", "감자탕", "부대찌개",
  "아귀찜", "낙지볶음", "쭈꾸미", "보쌈", "족발", "곱창", "막창", "갈비", "불고기",
  "삼겹살", "장어구이", "물회", "회", "초밥", "짬뽕", "탕수육", "돈까스", "떡볶이",
  "만두", "한정식", "백반", "국밥", "육회", "매운탕", "짜장면", "냉면", "쌀국수",
];

/**
 * 유명 음식명으로 그 음식의 맛집을 발굴(searchKeyword2).
 * 지역 무작위 나열보다 "그 음식으로 이름난 집"을 정조준하므로 콘텐츠 적합도가 높음.
 * fetchCandidates와 동일한 품질 정렬(사진 여러 장 우선)을 적용해 Spot[] 반환.
 */
export async function fetchByFoodKeyword(keyword = pick(FOOD_KEYWORDS)): Promise<Spot[]> {
  const items = await call("searchKeyword2", {
    keyword,
    contentTypeId: "39",
    arrange: pick(["Q", "R"]), // 알려진 곳(Q)·숨은 곳(R) 섞기
    numOfRows: "50",
    pageNo: "1",
  });
  console.log(`[keyword] "${keyword}" 후보 ${items.length}건`);
  return rankFoodItems(items, "맛집");
}

/** 검색 결과 아이템 → Spot[] (저작권 필터 + 사진 많은 곳 우선 + 등급 내 셔플) */
// 음식점(39) 하위분류 중 '식당(식사)'이 아닌 것 — 카페/전통찻집·클럽(바)은 제외해
// 맛집(밥집) 정체성 유지. (A05020100 한식 / 0200 서양식 / 0300 일식 / 0400 중식 /
//  0700 이색음식점 은 유지, 0900 카페·전통찻집 / 1000 클럽 은 제외)
const NON_RESTAURANT_CAT3 = new Set(["A05020900", "A05021000"]);

function rankFoodItems(items: any[], category: string): Spot[] {
  const mapped = items
    .filter((it: any) => it.firstimage)
    // 공공누리 유형 필터: Type1(출처표시), Type3(출처표시+변경금지)만 상업적 이용 가능.
    // Type2/Type4는 상업적 이용 금지라 제외.
    .filter((it: any) => it.cpyrhtDivCd === "Type1" || it.cpyrhtDivCd === "Type3")
    // 카페·라운지(바)류 제외 — 실제 식당만
    .filter((it: any) => !NON_RESTAURANT_CAT3.has(it.cat3))
    .map((it: any) => ({
      hasMulti: Boolean(it.firstimage2), // 사진 여러 장(품질 프록시)
      spot: {
        contentId: String(it.contentid),
        name: it.title,
        address: [it.addr1, it.addr2].filter(Boolean).join(" "),
        category,
        imageUrl: toHttps(it.firstimage),
        imageUrls: [toHttps(it.firstimage)],
        overview: "",
        mapx: it.mapx ? String(it.mapx) : undefined,
        mapy: it.mapy ? String(it.mapy) : undefined,
      } as Spot,
    }));
  // 사진 여러 장인 곳을 앞으로, 각 등급 안에서는 셔플(다양성)
  const shuffle = <T,>(a: T[]) => a.sort(() => Math.random() - 0.5);
  const multi = shuffle(mapped.filter((m) => m.hasMulti)).map((m) => m.spot);
  const single = shuffle(mapped.filter((m) => !m.hasMulti)).map((m) => m.spot);
  return [...multi, ...single];
}

/**
 * 좌표 기준 근처 가볼 만한 곳 최대 2곳 (DM에 끼워주는 보너스 추천).
 * locationBasedList2, 반경 3km, 거리순.
 */
export async function fetchNearby(
  mapx: string,
  mapy: string,
  excludeName: string
): Promise<NearbySpot[]> {
  try {
    const items = await call("locationBasedList2", {
      mapX: mapx,
      mapY: mapy,
      radius: "3000",
      arrange: "S", // 거리순 + 대표이미지 있는 항목
      numOfRows: "10",
      pageNo: "1",
    });
    return items
      .filter(
        (it: any) =>
          it.title &&
          it.title !== excludeName &&
          // 관광지(12)·문화시설(14)·음식점(39)만 추천 (숙박·쇼핑 등 제외)
          ["12", "14", "39"].includes(String(it.contenttypeid))
      )
      .slice(0, 2)
      .map((it: any) => ({
        name: it.title,
        address: [it.addr1, it.addr2].filter(Boolean).join(" "),
        category: String(it.contenttypeid) === "39" ? "맛집" : "가볼 곳",
        distM: Math.round(Number(it.dist) || 0),
      }));
  } catch {
    return [];
  }
}

/**
 * 장소의 추가 이미지들을 가져와 대표 이미지와 합쳐 최대 MAX_IMAGES장 반환.
 * (detailImage2 = 콘텐츠 이미지 목록)
 */
// 인스타에 어울리지 않는 편의시설 사진 제외 (imgname 라벨 기준).
// 예: "장애인화장실 내부", "장애인주차장", "기저귀 교환대" 등.
const BAD_IMG_NAME =
  /(화장실|주차|기저귀|수유|경사로|안내도|안내판|표지판|매표|엘리베이터|승강기|휠체어|점자|유도블록|소화전|진입로|비상|피난|보관함|매표소|안내소)/;

// 퀴즈형(상호 비공개) 게시물에서 정답이 새는 사진 라벨 — 간판·외관류 (맛집 전용)
const SIGN_LABEL = /(간판|외관|전경|입구|정면|외부|매장 ?앞|점포|건물)/;

export async function fetchImages(
  contentId: string,
  firstImage: string
): Promise<string[]> {
  // 대표 이미지(firstimage)는 관광공사가 고른 사진이라 항상 포함.
  const urls = new Set<string>([toHttps(firstImage)]);
  try {
    const items = await call("detailImage2", {
      contentId,
      imageYN: "Y",
      numOfRows: "30",
    });
    for (const it of items) {
      // 화장실·주차장 등 편의시설 사진은 라벨로 걸러냄
      if (it.imgname && BAD_IMG_NAME.test(it.imgname)) continue;
      const u = it.originimgurl || it.smallimageurl;
      if (u) urls.add(toHttps(u));
      if (urls.size >= MAX_IMAGES) break;
    }
  } catch {
    // 추가 이미지 실패 시 대표 이미지만
  }
  return [...urls].slice(0, MAX_IMAGES);
}

/**
 * 퀴즈형(상호 비공개) 게시물용 이미지 수집 — 간판 제외 + 좋은 사진 앞으로 정렬.
 * 1차: imgname 라벨 필터(맛집은 간판·외관류 라벨 제거)
 * 2차: Gemini 비전 한 번으로 ①간판·상호 글자 사진 제외 ②가장 먹음직/멋진 사진 순서로
 *      재정렬 → 인스타 썸네일(첫 사진)이 항상 제일 좋은 컷이 되게 함. (키 없으면 생략)
 * 실패 시 안전하게 1차(라벨 필터) 결과 반환.
 */
export async function fetchQuizImages(
  contentId: string,
  firstImage: string,
  category = "맛집"
): Promise<string[]> {
  // 후보 수집 (url + 판별용 썸네일)
  let cands: { url: string; small: string; name: string }[] = [
    { url: toHttps(firstImage), small: toHttps(firstImage), name: "" },
  ];
  try {
    const items = await call("detailImage2", { contentId, imageYN: "Y", numOfRows: "30" });
    for (const it of items) {
      const name = String(it.imgname ?? "");
      if (name && BAD_IMG_NAME.test(name)) continue;
      // 맛집은 라벨상 간판·외관류도 미리 제거 (여행지는 전경이 본체라 유지)
      if (category === "맛집" && name && SIGN_LABEL.test(name)) continue;
      const url = toHttps(it.originimgurl || it.smallimageurl);
      if (!url) continue;
      cands.push({ url, small: toHttps(it.smallimageurl || it.originimgurl), name });
    }
  } catch {
    /* 추가 이미지 실패 시 대표 이미지만 */
  }
  cands = cands.filter((v, i, a) => a.findIndex((x) => x.url === v.url) === i).slice(0, 12);

  // 2차: Gemini 비전 간판 감지
  if (process.env.GEMINI_API_KEY && cands.length > 1) {
    try {
      const valid: typeof cands = [];
      const parts: any[] = [];
      for (const c of cands) {
        try {
          const res = await fetch(c.small, { signal: AbortSignal.timeout(15000) });
          if (!res.ok) continue;
          const b = Buffer.from(await res.arrayBuffer());
          if (b.length > 900_000) continue;
          valid.push(c);
          parts.push({ inlineData: { mimeType: "image/jpeg", data: b.toString("base64") } });
        } catch {
          /* skip */
        }
      }
      if (valid.length > 1) {
        const goodDesc =
          category === "맛집"
            ? "음식·요리가 크고 먹음직스럽게 나온"
            : "풍경·볼거리가 시원하게 잘 담긴";
        const text =
          (await geminiText(
            [
              {
                text: `가게/장소 사진 ${valid.length}장이야(1번부터). 두 가지를 JSON으로만 답해줘.
- exclude: 간판·상호명·현판·메뉴판 등 '가게 이름 글자'가 크게 보이는 사진 번호 배열
  (상호·위치가 드러나므로 반드시 제외). 심하게 흐릿하거나 어두운 사진도 포함. 없으면 [].
  ※ 내부 인테리어·분위기·테이블 사진은 이름 글자만 없으면 제외하지 마.
- best: 나머지 중 ${goodDesc} 보기 좋은 사진을 좋은 순서(가장 좋은 게 앞)로 나열한 번호 배열
형식: {"exclude":[..],"best":[..]}`,
              },
              ...parts,
            ],
            200
          )) ?? "";
        const m = text.match(/\{[\s\S]*\}/);
        let parsed: { exclude?: number[]; best?: number[] } | null = null;
        if (m) {
          try {
            parsed = JSON.parse(m[0]);
          } catch {
            parsed = null; // 파싱 실패 → 라벨 필터 폴백
          }
        }
        if (parsed) {
          const excl = new Set((parsed.exclude ?? []).map(Number));
          const bestOrder = (parsed.best ?? []).map(Number).filter((n) => n >= 1 && n <= valid.length);
          const keptIdx = valid.map((_, i) => i + 1).filter((n) => !excl.has(n));
          // best 순서를 앞에 두고, 언급 안 된 나머지는 원래 순서로 뒤에 붙임
          const seen = new Set<number>();
          const ordered: number[] = [];
          for (const n of bestOrder) if (!excl.has(n) && !seen.has(n)) { ordered.push(n); seen.add(n); }
          for (const n of keptIdx) if (!seen.has(n)) { ordered.push(n); seen.add(n); }
          // ⚠️ 비전이 판정에 성공하면 그 결과를 신뢰 — 제외된 간판을 다시 넣지 않는다.
          // 좋은 사진이 부족하면 적은 수/빈 배열을 반환 → 상위에서 MIN_IMAGES 미달로 스킵
          // (간판·상호가 표지로 나가 위치가 노출되는 것보다 발행을 건너뛰는 게 낫다).
          return ordered.map((n) => valid[n - 1].url).slice(0, MAX_IMAGES);
        }
      }
    } catch {
      /* 비전 호출 자체 실패 시에만 라벨 필터 결과로 폴백 */
    }
  }
  return cands.map((c) => c.url).slice(0, MAX_IMAGES);
}

/** 상호명으로 TourAPI에서 장소+이미지 확보 (카카오 발굴 이름 → 사진 연결용) */
export async function fetchSpotByName(
  name: string,
  regionHint = ""
): Promise<Spot | null> {
  try {
    const items = await call("searchKeyword2", {
      keyword: name,
      contentTypeId: "39",
      numOfRows: "5",
    });
    const norm = (s: string) => s.replace(/\[[^\]]*\]/g, "").replace(/\s+/g, "");
    const hit = items.find(
      (it: any) =>
        it.firstimage &&
        (it.cpyrhtDivCd === "Type1" || it.cpyrhtDivCd === "Type3") &&
        (norm(it.title).includes(norm(name)) || norm(name).includes(norm(it.title))) &&
        (!regionHint || String(it.addr1 ?? "").includes(regionHint.slice(0, 2)))
    );
    if (!hit) return null;
    const imageUrls = await fetchQuizImages(String(hit.contentid), String(hit.firstimage), "맛집");
    if (imageUrls.length < MIN_IMAGES) return null;
    return {
      contentId: String(hit.contentid),
      name: hit.title,
      address: [hit.addr1, hit.addr2].filter(Boolean).join(" "),
      category: "맛집",
      imageUrl: toHttps(hit.firstimage),
      imageUrls,
      overview: "",
      mapx: hit.mapx ? String(hit.mapx) : undefined,
      mapy: hit.mapy ? String(hit.mapy) : undefined,
    };
  } catch {
    return null;
  }
}

/** 상세 설명(overview) 채우기 */
export async function fetchOverview(contentId: string): Promise<string> {
  try {
    const items = await call("detailCommon2", { contentId });
    return (items[0]?.overview ?? "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  } catch {
    return "";
  }
}

export interface FoodInfo {
  menu: string; // 대표 메뉴 (없으면 "")
  hours: string; // 영업시간 (없으면 "")
}

/** 음식점 상세(detailIntro2)에서 대표메뉴·영업시간 추출 — 캡션 정보 고도화용 */
export async function fetchFoodInfo(contentId: string): Promise<FoodInfo> {
  const clean = (s: any) =>
    String(s ?? "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&[a-z]+;/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
  try {
    const items = await call("detailIntro2", { contentId, contentTypeId: "39" });
    const it = items[0] ?? {};
    // 대표메뉴 우선, 없으면 취급메뉴에서 앞부분만
    const trimJoin = (s: string) =>
      s.split(/\s*,\s*/).map((x) => x.trim()).filter(Boolean).slice(0, 4).join(", ");
    const menu = trimJoin(clean(it.firstmenu) || clean(it.treatmenu));
    // 영업시간 정리: 앞머리 불릿 제거 + 세그먼트 구분 대시(뒤에 한글이 오는 "-")는
    // " · "로 바꾸되, 시간범위 대시("10:00 - 22:00", 뒤가 숫자)는 그대로 보존.
    const hours = clean(it.opentimefood)
      .replace(/^[-·•\s]+/, "")
      .replace(/\s*-\s*(?=[가-힣])/g, " · ")
      // 용어 통일
      .replace(/준비\s*시간/g, "브레이크타임")
      .replace(/마지막\s*주문/g, "라스트오더")
      .slice(0, 60)
      .trim();
    return { menu: menu.slice(0, 60), hours };
  } catch {
    return { menu: "", hours: "" };
  }
}
