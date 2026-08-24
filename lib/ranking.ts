import { blogBuzz, cafeBuzz, buzzQuery } from "./naver";
import { ytBuzz } from "./youtube";

// 합성 인기 랭킹 — "진짜 순위 데이터" 3축 (2026-08 사용자 요청):
//   ① 네이버 블로그 후기 수 (글 쓸 만큼 다녀간 사람의 양)
//   ② 유튜브 버즈: 상위 영상 조회수 (방송·유명 먹방 출연이 그대로 잡힘)
//   ③ 네이버 지역검색 리뷰순(sort=comment) 상위 진입 보너스 (방문자 리뷰 기반)
//   ④ 네이버 카페글 수 (맘카페·지역카페 실방문 후기 — 실측: 봉피양 2,005 vs 무명 0)
// 각 신호는 자릿수가 달라 log10으로 눌러 합산한다. 키 없음·호출 실패는 그 축만
// 0점 처리 — 전 축이 죽으면 scored=false로 호출부가 수집 순서를 그대로 쓴다.

const NAVER_LOCAL = "https://openapi.naver.com/v1/search/local.json";

/** 지역검색 리뷰 많은 순 상위 5곳의 상호명 (정규화). 실패 시 [] */
async function commentTop(query: string): Promise<string[]> {
  const id = process.env.NAVER_CLIENT_ID, secret = process.env.NAVER_CLIENT_SECRET;
  if (!id || !secret) return [];
  try {
    const r = await fetch(
      `${NAVER_LOCAL}?query=${encodeURIComponent(query)}&display=5&sort=comment`,
      {
        headers: { "X-Naver-Client-Id": id, "X-Naver-Client-Secret": secret },
        signal: AbortSignal.timeout(10000),
      }
    );
    const j: any = await r.json();
    return (j.items ?? []).map((it: any) =>
      String(it.title ?? "").replace(/<[^>]+>/g, "").replace(/\s+/g, "")
    );
  } catch {
    return [];
  }
}

const norm = (s: string) => String(s).replace(/\([^)]*\)/g, "").replace(/\s+/g, "");

export interface RankedPlace {
  buzz: number; // 블로그 후기 수 (기존 필드명 유지 — 캡션·로그 호환)
  cafe: number; // 카페글 수
  ytViews: number;
  commentPos: number; // 리뷰순 상위 진입 순위 (1~5, 미진입 0)
  score: number;
}

/**
 * places를 합성 점수 내림차순으로 정렬해 반환.
 * keyword: 테마 음식명 — 리뷰순 조회 쿼리("지역 keyword")에 사용.
 */
export async function rankComposite<T extends { name: string; address?: string; region?: string }>(
  places: T[],
  keyword: string
): Promise<{ ranked: Array<T & RankedPlace>; scored: boolean; basis: string } | null> {
  // 리뷰순 상위 목록은 지역 단위라 같은 지역 후보끼리 캐시
  const topCache = new Map<string, string[]>();
  const out: Array<T & RankedPlace> = [];

  for (const p of places) {
    const q = buzzQuery(p.name, p.address);
    const blog = (await blogBuzz(q)) ?? 0;
    const cafe = (await cafeBuzz(q)) ?? 0;
    const yt = await ytBuzz(q);

    let commentPos = 0;
    const region = p.region ?? String(p.address ?? "").split(/\s+/).slice(0, 2).join(" ");
    if (region) {
      const key = `${region} ${keyword}`;
      if (!topCache.has(key)) topCache.set(key, await commentTop(key));
      const idx = topCache.get(key)!.findIndex((t) => {
        const n = norm(p.name);
        return t && n && (t.includes(n) || n.includes(t));
      });
      if (idx >= 0) commentPos = idx + 1;
    }

    // log10 합산: 블로그(수백~수만 → 2~4.5점), 유튜브 조회수(만~백만 → 3~6점)는
    // 0.7로 눌러 균형, 리뷰순 진입은 1위 +1.5 ~ 5위 +0.3.
    const score =
      Math.log10(blog + 1) +
      0.5 * Math.log10(cafe + 1) +
      0.7 * Math.log10((yt?.topViews ?? 0) + 1) +
      (commentPos > 0 ? (6 - commentPos) * 0.3 : 0);

    out.push({ ...p, buzz: blog, cafe, ytViews: yt?.topViews ?? 0, commentPos, score });
  }

  const scored = out.some((p) => p.score > 0);
  out.sort((a, b) => b.score - a.score);

  const parts = [
    out.some((p) => p.buzz > 0 || p.cafe > 0) ? "네이버 후기" : "",
    out.some((p) => p.ytViews > 0) ? "유튜브 조회수" : "",
    out.some((p) => p.commentPos > 0) ? "방문자 리뷰" : "",
  ].filter(Boolean);
  return { ranked: out, scored, basis: parts.join("·") || "수집 순서" };
}
