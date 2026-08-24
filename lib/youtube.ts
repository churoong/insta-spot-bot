// YouTube Data API v3 — 식당의 "유튜브 버즈" (영상 수 + 상위 조회수).
//
// 무료 일 10,000유닛(카드 불필요), 검색 1회 100유닛 + 통계 1유닛 ≈ 101유닛/식당.
// 카운트다운 하루 5~6곳이면 ~600유닛 — 여유 충분. 방송·유명 먹방 출연이
// 조회수로 그대로 잡혀서 "진짜 유명한 집" 신호로는 블로그 수보다 강하다.
// (실측: 봉피양 → 영상 5,526개, 상위 조회수 25만~84만)

const YT = "https://www.googleapis.com/youtube/v3";

export interface YtBuzz {
  /** 검색 결과 수 (근사치) */
  videos: number;
  /** 상위 5개 영상 조회수 합 */
  topViews: number;
}

/** 키 없음·쿼터 소진·오류 모두 null — 호출부는 블로그 수 단독으로 폴백 */
export async function ytBuzz(query: string): Promise<YtBuzz | null> {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) return null;
  try {
    const s: any = await (
      await fetch(
        `${YT}/search?part=snippet&type=video&maxResults=5&q=${encodeURIComponent(query)}&key=${key}`,
        { signal: AbortSignal.timeout(15000) }
      )
    ).json();
    if (s?.error) {
      console.error("[youtube] 검색 실패:", String(s.error.message ?? "").slice(0, 100));
      return null;
    }
    const ids = (s.items ?? []).map((i: any) => i?.id?.videoId).filter(Boolean);
    let topViews = 0;
    if (ids.length) {
      const v: any = await (
        await fetch(`${YT}/videos?part=statistics&id=${ids.join(",")}&key=${key}`, {
          signal: AbortSignal.timeout(15000),
        })
      ).json();
      for (const it of v.items ?? []) topViews += Number(it?.statistics?.viewCount ?? 0);
    }
    return { videos: Number(s.pageInfo?.totalResults ?? 0), topViews };
  } catch (e) {
    console.error("[youtube] 오류:", String(e).slice(0, 80));
    return null;
  }
}
