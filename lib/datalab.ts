// 네이버 데이터랩 검색어 트렌드 — "사람들이 실제로 많이 찾아보는 집"을 근거로
// 큐레이션 순위를 매기는 데 쓴다. (저장수·평점은 어느 지도 API도 공식 제공하지 않음)
//
// 필요 환경변수: NAVER_CLIENT_ID, NAVER_CLIENT_SECRET
//   (없으면 조용히 null 반환 → 호출부는 기존 순서를 그대로 사용)
//
// API 특성:
//  - 한 번에 키워드 그룹 최대 5개, 각 그룹당 키워드 최대 20개
//  - 절대 검색량이 아니라 '기간 내 최댓값을 100으로 한 상대값'을 준다.
//    같은 요청 안에서의 그룹 간 비교는 유효하므로 순위 매기기에는 충분하다.

const ENDPOINT = "https://openapi.naver.com/v1/datalab/search";

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * 키워드들의 상대 검색량 점수를 구한다 (0~100, 높을수록 많이 검색됨).
 * 최대 5개씩 끊어 호출하며, 실패하면 null.
 */
export async function searchScores(keywords: string[]): Promise<Record<string, number> | null> {
  const id = process.env.NAVER_CLIENT_ID;
  const secret = process.env.NAVER_CLIENT_SECRET;
  if (!id || !secret || keywords.length === 0) return null;

  const end = new Date();
  const start = new Date(end.getTime() - 90 * 24 * 3600 * 1000); // 최근 3개월
  const scores: Record<string, number> = {};

  // 데이터랩은 요청당 그룹 5개 제한 → 5개씩 나눠 호출
  for (let i = 0; i < keywords.length; i += 5) {
    const chunk = keywords.slice(i, i + 5);
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          "X-Naver-Client-Id": id,
          "X-Naver-Client-Secret": secret,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          startDate: ymd(start),
          endDate: ymd(end),
          timeUnit: "month",
          keywordGroups: chunk.map((k) => ({ groupName: k, keywords: [k] })),
        }),
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) {
        console.error("[datalab] HTTP", res.status, (await res.text()).slice(0, 120));
        continue;
      }
      const json = await res.json();
      for (const r of json?.results ?? []) {
        // 기간 내 평균을 그 키워드의 점수로 사용
        const vals = (r?.data ?? []).map((d: any) => Number(d.ratio) || 0);
        const avg = vals.length ? vals.reduce((a: number, b: number) => a + b, 0) / vals.length : 0;
        scores[String(r.title)] = Math.round(avg * 10) / 10;
      }
    } catch (e) {
      console.error("[datalab] 실패:", String(e).slice(0, 100));
    }
  }
  return Object.keys(scores).length ? scores : null;
}

/**
 * 장소 목록을 검색량 기준으로 내림차순 정렬해 반환.
 * 데이터랩을 못 쓰면 원본 순서를 그대로 돌려준다(안전 폴백).
 */
export async function rankBySearchVolume<T extends { name: string; region?: string }>(
  places: T[]
): Promise<{ ranked: T[]; scored: boolean }> {
  // 상호명만으로는 일반명사와 섞이므로 지역을 붙여 정확도를 높인다
  const queries = places.map((p) => `${p.region ? p.region + " " : ""}${p.name}`.trim());
  const scores = await searchScores(queries);
  if (!scores) return { ranked: places, scored: false };

  const withScore = places.map((p, i) => ({ p, s: scores[queries[i]] ?? 0 }));
  withScore.sort((a, b) => b.s - a.s);
  return { ranked: withScore.map((x) => x.p), scored: true };
}
