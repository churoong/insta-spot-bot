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
  imageUrl: string;
  overview: string;
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
      imageUrl: String(it.firstimage).replace(/^http:/, "https:"),
      overview: "",
    }));
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
