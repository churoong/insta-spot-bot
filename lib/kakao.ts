// 카카오 로컬 API — 장소 검색·좌표·카카오맵 링크 (공식 API, 무료).
// 평점·리뷰 같은 서비스 데이터는 쓰지 않고, 좌표·주소·place_url(길찾기 링크)만 활용.
// KAKAO_REST_KEY 없으면 전부 폴백(빈 결과/링크 없음)이라 없어도 봇은 정상 동작.

const KEY = () => process.env.KAKAO_REST_KEY;

export interface KakaoPlace {
  name: string;
  address: string; // 지번
  roadAddress: string; // 도로명
  mapx: string; // 경도(x)
  mapy: string; // 위도(y)
  placeUrl: string; // 카카오맵 장소 페이지(길찾기 가능)
  category: string;
}

async function call(path: string, params: Record<string, string>) {
  if (!KEY()) return null;
  const qs = new URLSearchParams(params);
  const res = await fetch(`https://dapi.kakao.com/v2/local/${path}?${qs}`, {
    headers: { Authorization: `KakaoAK ${KEY()}` },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`Kakao ${path} HTTP ${res.status}`);
  return res.json();
}

function toPlace(d: any): KakaoPlace {
  return {
    name: String(d.place_name ?? ""),
    address: String(d.address_name ?? ""),
    roadAddress: String(d.road_address_name ?? ""),
    mapx: String(d.x ?? ""), // 경도
    mapy: String(d.y ?? ""), // 위도
    placeUrl: String(d.place_url ?? ""),
    category: String(d.category_name ?? "").split(">").pop()?.trim() ?? "",
  };
}

/**
 * 상호명(+지역 힌트)으로 카카오맵에서 장소를 찾아 place_url(길찾기 링크) 등 반환.
 * 이름 매칭 + (지역 힌트 있으면) 주소 대조로 동명 오매칭 방지.
 */
export async function findPlace(name: string, regionHint = ""): Promise<KakaoPlace | null> {
  try {
    const query = regionHint ? `${regionHint} ${name}` : name;
    const json = await call("search/keyword.json", { query, size: "5" });
    const docs: any[] = json?.documents ?? [];
    if (docs.length === 0) return null;
    const norm = (s: string) => s.replace(/\s+/g, "");
    const hit =
      docs.find((d) => {
        const nm = norm(String(d.place_name));
        const target = norm(name);
        const nameOk = nm.includes(target) || target.includes(nm);
        const regionOk =
          !regionHint ||
          String(d.address_name ?? "").includes(regionHint.slice(0, 2)) ||
          String(d.road_address_name ?? "").includes(regionHint.slice(0, 2));
        return nameOk && regionOk;
      }) ?? null;
    return hit ? toPlace(hit) : null;
  } catch {
    return null;
  }
}

/**
 * 키워드(+지역/카테고리)로 맛집 후보 목록. 후보 발굴 범위 확대용.
 * 사진은 카카오에서 못 받으므로, 이름을 TourAPI에서 다시 찾아 사진 확보하는 용도.
 */
export async function searchPlaces(
  keyword: string,
  region = "",
  limit = 15
): Promise<KakaoPlace[]> {
  try {
    const query = region ? `${region} ${keyword}` : `${keyword} 맛집`;
    const json = await call("search/keyword.json", {
      query,
      size: String(Math.min(15, limit)),
      category_group_code: "FD6", // 음식점
    });
    const docs: any[] = json?.documents ?? [];
    return docs.map(toPlace);
  } catch {
    return [];
  }
}

// 후보 발굴용 랜덤 키워드·지역 (카카오로 이름 발굴 → TourAPI 사진 연결)
const DISHES = ["돼지국밥", "순대국", "칼국수", "냉면", "국밥", "곰탕", "막국수", "짬뽕", "설렁탕", "추어탕", "감자탕", "닭갈비", "물회", "매운탕", "백반"];
const CITIES = ["서울", "부산", "대구", "인천", "광주", "대전", "울산", "수원", "전주", "청주", "천안", "창원", "포항", "강릉", "여수", "제주"];

const rand = <T>(a: T[]): T => a[Math.floor(Math.random() * a.length)];

/**
 * 카카오로 "지역+메뉴" 맛집 이름을 발굴하고 TourAPI에서 사진 있는 곳을 찾아 Spot 반환.
 * TourAPI 자체 키워드 랭킹과 다른 후보를 발굴해 다양성을 높인다. 키 없으면 null.
 */
export async function pickKakaoSpot(): Promise<import("./tourapi").Spot | null> {
  if (!KEY()) return null;
  const { fetchSpotByName, fetchOverview } = await import("./tourapi");
  for (let attempt = 0; attempt < 2; attempt++) {
    const region = rand(CITIES);
    const dish = rand(DISHES);
    const places = await searchPlaces(dish, region, 15);
    for (const kp of places.sort(() => Math.random() - 0.5)) {
      const spot = await fetchSpotByName(kp.name, region);
      if (spot) {
        spot.overview = await fetchOverview(spot.contentId);
        // 카카오 좌표·링크로 보강
        if (kp.mapx && kp.mapy) {
          spot.mapx = kp.mapx;
          spot.mapy = kp.mapy;
        }
        (spot as any).mapUrl = mapLink(kp);
        return spot;
      }
    }
  }
  return null;
}

/** 카카오맵 길찾기 링크 (place_url 있으면 그걸, 없으면 좌표 기반 URL) */
export function mapLink(p: { placeUrl?: string; name?: string; mapx?: string; mapy?: string }): string {
  if (p.placeUrl) return p.placeUrl;
  if (p.name) return searchMapUrl(p.name);
  return "https://map.kakao.com";
}

/**
 * 키·승인 없이 만드는 카카오맵 검색 링크 (상호명+지역).
 * 로컬 API 승인 전에도 DM 길찾기 링크를 제공하기 위한 기본 방식.
 * 탭하면 카카오맵(웹/앱)에서 해당 장소를 검색해 보여줌.
 */
export function searchMapUrl(name: string, region = ""): string {
  const q = [region, name].filter(Boolean).join(" ");
  return `https://map.kakao.com/link/search/${encodeURIComponent(q)}`;
}
