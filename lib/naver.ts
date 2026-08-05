// 네이버 지역검색 — "지역 + 음식"으로 검색했을 때 상위에 나오는 업체를 가져온다.
// 네이버 검색 상위 = 실제로 많이 찾고 유명한 집이라, TourAPI에서 무작위로 뽑는 것보다
// '검증된 맛집'을 발굴할 수 있다. 사진은 상호명으로 TourAPI에서 매칭해 가져온다.
//
// 필요 환경변수: NAVER_CLIENT_ID, NAVER_CLIENT_SECRET (없으면 null 반환 → 기존 발굴 사용)
// 무료 한도: 하루 25,000회로 넉넉함.

export interface NaverPlace {
  name: string; // 상호명 (HTML 태그 제거됨)
  category: string; // 예: "음식점>한식>국밥"
  address: string; // 지번 주소
  roadAddress: string;
  rank: number; // 검색 결과 순위(1부터) — 네이버 기준 인기·관련도
}

const stripTags = (s: string) =>
  String(s ?? "")
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .trim();

/**
 * 네이버 지역검색. 검색 결과 순서를 그대로 유지해 반환(= 네이버 랭킹).
 * 실패하거나 키가 없으면 null.
 */
export async function searchLocal(query: string, display = 5): Promise<NaverPlace[] | null> {
  const id = process.env.NAVER_CLIENT_ID;
  const secret = process.env.NAVER_CLIENT_SECRET;
  if (!id || !secret) return null;
  try {
    const url =
      `https://openapi.naver.com/v1/search/local.json?query=${encodeURIComponent(query)}` +
      `&display=${Math.min(display, 5)}&sort=random`; // sort=random이 네이버 기본 정확도순
    const res = await fetch(url, {
      headers: { "X-Naver-Client-Id": id, "X-Naver-Client-Secret": secret },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      console.error("[naver] 지역검색 HTTP", res.status, (await res.text()).slice(0, 120));
      return null;
    }
    const json = await res.json();
    const items = Array.isArray(json?.items) ? json.items : [];
    return items
      .map((it: any, i: number) => ({
        name: stripTags(it.title),
        category: stripTags(it.category),
        address: stripTags(it.address),
        roadAddress: stripTags(it.roadAddress),
        rank: i + 1,
      }))
      .filter((p: NaverPlace) => p.name);
  } catch (e) {
    console.error("[naver] 지역검색 실패:", String(e).slice(0, 100));
    return null;
  }
}

/**
 * 블로그 후기 수 — 그 가게에 대해 쓰인 블로그 글 개수.
 * 실측상 인기도를 아주 잘 반영한다(쌍둥이돼지국밥 16,147건 vs 무명집 4건).
 * 데이터랩은 신규 등록이 막혔지만 이건 '검색' 권한만으로 쓸 수 있다.
 * 실패하면 null.
 */
export async function blogBuzz(query: string): Promise<number | null> {
  const id = process.env.NAVER_CLIENT_ID;
  const secret = process.env.NAVER_CLIENT_SECRET;
  if (!id || !secret || !query.trim()) return null;
  try {
    const res = await fetch(
      `https://openapi.naver.com/v1/search/blog.json?query=${encodeURIComponent(query)}&display=1`,
      {
        headers: { "X-Naver-Client-Id": id, "X-Naver-Client-Secret": secret },
        signal: AbortSignal.timeout(15000),
      }
    );
    if (!res.ok) return null;
    const json = await res.json();
    return Number(json?.total) || 0;
  } catch {
    return null;
  }
}

/** 가게 인기도 조회용 검색어 — 지역을 붙여야 동명 업소와 안 섞인다 */
export function buzzQuery(name: string, address?: string): string {
  const region = String(address ?? "").split(/\s+/)[1] || String(address ?? "").split(/\s+/)[0] || "";
  const clean = String(name).replace(/\[[^\]]*\]/g, "").trim();
  return `${region} ${clean}`.trim();
}

/**
 * 여러 곳의 블로그 후기 수를 조회해 인기순으로 정렬.
 * 조회 실패한 곳은 0으로 취급. 키가 없으면 원본 순서 유지.
 */
export async function rankByBuzz<T extends { name: string; address?: string }>(
  places: T[]
): Promise<{ ranked: Array<T & { buzz: number }>; scored: boolean } | null> {
  if (!process.env.NAVER_CLIENT_ID || !process.env.NAVER_CLIENT_SECRET) return null;
  const withBuzz: Array<T & { buzz: number }> = [];
  for (const p of places) {
    const n = await blogBuzz(buzzQuery(p.name, p.address));
    withBuzz.push({ ...p, buzz: n ?? 0 });
  }
  const scored = withBuzz.some((p) => p.buzz > 0);
  withBuzz.sort((a, b) => b.buzz - a.buzz);
  return { ranked: withBuzz, scored };
}

/**
 * 카페·주점 등 '식사'가 아닌 업종 제외 (계정 정체성: 순수 음식점).
 * ⚠️ 네이버 카테고리는 "한식>국밥"처럼 '음식점' 단어가 없는 경우가 많다.
 *    따라서 포함 조건이 아니라 '제외 키워드'로만 판별한다.
 */
export function isRestaurantCategory(category: string): boolean {
  const c = String(category ?? "");
  if (!c) return false;
  if (/(카페|디저트|베이커리|제과|빵|아이스크림|술집|주점|호프|바|와인|칵테일|PC|노래|숙박)/i.test(c)) {
    return false;
  }
  // 음식 관련 대분류만 통과 (한식/중식/일식/양식/분식/뷔페 등)
  return /(음식점|한식|중식|일식|양식|분식|뷔페|고기|해물|국밥|면|치킨|족발|곱창|아시아)/i.test(c);
}
