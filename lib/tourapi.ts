// 한국관광공사 TourAPI (KorService2) — 사진·정보의 합법적 출처.
// 공공데이터포털 이용약관상 출처 표기("한국관광공사") 조건으로 자유 이용 가능.

const BASE = "https://apis.data.go.kr/B551011/KorService2";

// 12=관광지, 39=음식점
const CONTENT_TYPES = [12, 39, 39]; // 맛집 비중을 높게
const AREA_CODES = [1, 2, 3, 4, 5, 6, 7, 8, 31, 32, 33, 34, 35, 36, 37, 38, 39];

export interface Spot {
  contentId: string;
  name: string;
  address: string;
  category: string; // "맛집" | "여행지"
  imageUrl: string; // 대표 이미지(썸네일)
  imageUrls: string[]; // 캐러셀용 전체 이미지 (대표 포함, 최대 10장)
  overview: string;
}

// 인스타 캐러셀 제약: 2~10장. 게시물당 최소 이 장수는 확보(부족하면 후보 건너뜀).
export const MIN_IMAGES = 5;
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

/** 대표 이미지가 있는 장소 후보 목록을 무작위 지역/유형에서 가져온다. */
export async function fetchCandidates(): Promise<Spot[]> {
  const contentTypeId = pick(CONTENT_TYPES);
  const areaCode = pick(AREA_CODES);
  const items = await call("areaBasedList2", {
    contentTypeId: String(contentTypeId),
    areaCode: String(areaCode),
    arrange: "R", // 생성일순 + 대표이미지 있는 항목만
    numOfRows: "50",
    pageNo: "1",
  });
  return items
    .filter((it: any) => it.firstimage)
    // 공공누리 유형 필터: Type1(출처표시), Type3(출처표시+변경금지)만 상업적 이용 가능.
    // Type2/Type4는 상업적 이용 금지라 제외.
    .filter((it: any) => it.cpyrhtDivCd === "Type1" || it.cpyrhtDivCd === "Type3")
    .map((it: any) => ({
      contentId: String(it.contentid),
      name: it.title,
      address: [it.addr1, it.addr2].filter(Boolean).join(" "),
      category: contentTypeId === 39 ? "맛집" : "여행지",
      imageUrl: toHttps(it.firstimage),
      imageUrls: [toHttps(it.firstimage)],
      overview: "",
    }));
}

/**
 * 장소의 추가 이미지들을 가져와 대표 이미지와 합쳐 최대 MAX_IMAGES장 반환.
 * (detailImage2 = 콘텐츠 이미지 목록)
 */
// 인스타에 어울리지 않는 편의시설 사진 제외 (imgname 라벨 기준).
// 예: "장애인화장실 내부", "장애인주차장", "기저귀 교환대" 등.
const BAD_IMG_NAME =
  /(화장실|주차|기저귀|수유|경사로|안내도|안내판|표지판|매표|엘리베이터|승강기|휠체어|점자|유도블록|소화전|진입로|비상|피난|보관함|매표소|안내소)/;

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
