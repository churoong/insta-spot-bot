// 한국관광공사 TourAPI (KorService2) — 사진·정보의 합법적 출처.
// 공공데이터포털 이용약관상 출처 표기("한국관광공사") 조건으로 자유 이용 가능.

import { geminiText } from "./llm";

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
      mapx: it.mapx ? String(it.mapx) : undefined,
      mapy: it.mapy ? String(it.mapy) : undefined,
    }));
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
 * 퀴즈형(상호 비공개) 게시물용 이미지 수집 — 간판·상호명 노출 사진 제외.
 * 1차: imgname 라벨 필터(맛집은 간판·외관류 라벨 제거)
 * 2차: Gemini 비전으로 간판·상호 글자가 보이는 사진 감지·제외 (키 없으면 생략)
 * 필터 후에도 원본 순서 유지. 실패 시 안전하게 1차 결과 반환.
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
        const text =
          (await geminiText(
            [
              {
                text: `사진 ${valid.length}장이야. 가게 간판, 상호명, 현판 등 장소 이름을 읽을 수 있는 글자가 보이는 사진의 번호를 JSON 배열로만 답해 (1번부터). 없으면 []. 예: [1,4]`,
              },
              ...parts,
            ],
            60
          )) ?? "";
        const m = text.match(/\[[\d,\s]*\]/);
        if (m) {
          const signed = new Set((JSON.parse(m[0]) as number[]).map((n) => Number(n)));
          const kept = valid.filter((_, i) => !signed.has(i + 1));
          // 비전 결과 반영하되, 너무 많이 깎이면(2장 미만) 1차 결과 유지
          if (kept.length >= 2) return kept.map((c) => c.url).slice(0, MAX_IMAGES);
        }
      }
    } catch {
      /* 비전 실패 시 1차 결과 */
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
