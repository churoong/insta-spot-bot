// Instagram Audio API — 릴스에 인스타 음악 라이브러리(라이선스 음악)를 붙인다.
//
// 2026-06-01 Meta 공식 출시. ⚠️ Facebook Login 기반(graph.facebook.com) 전용이라
// 이 봇의 기본 발행 경로(Instagram Login, graph.instagram.com)로는 못 쓴다.
// FB_ACCESS_TOKEN(페이지 연동 토큰) + FB_IG_USER_ID(17841…형 IG 비즈니스 계정 ID)가
// 설정된 경우에만 동작하고, 없으면 null을 돌려 기존 방식(CC BGM 굽기)으로 폴백한다.
//
// 문서: developers.facebook.com/docs/instagram-platform/content-publishing/audio-api/
//  - GET /ig_audio?audio_type=music&user_id=…            → 트렌딩 (search_query 생략 시)
//  - 컨테이너 생성 시 audio_configuration={audio_id, audio_volume, video_volume}
//  - 카탈로그는 "서드파티 사용 허가" 곡만이라 앱보다 좁고, 곡은 항상 0초부터 재생.

const GRAPH_FB = "https://graph.facebook.com/v23.0";

export function fbMusicConfigured(): boolean {
  return Boolean(process.env.FB_ACCESS_TOKEN && process.env.FB_IG_USER_ID);
}

export interface IgAudio {
  id: string;
  title?: string;
  artist?: string;
}

/**
 * 트렌딩 음악 중 상위권에서 랜덤 1곡. (query를 주면 검색 결과에서)
 * 미설정·오류·빈 결과 모두 null — 호출부는 CC BGM 굽기로 폴백.
 */
export async function pickTrendingAudio(query?: string): Promise<IgAudio | null> {
  if (!fbMusicConfigured()) return null;
  try {
    const qs = new URLSearchParams({
      audio_type: "music",
      user_id: process.env.FB_IG_USER_ID!,
      access_token: process.env.FB_ACCESS_TOKEN!,
    });
    if (query) qs.set("search_query", query);
    const res = await fetch(`${GRAPH_FB}/ig_audio?${qs}`, { signal: AbortSignal.timeout(20000) });
    const json: any = await res.json();
    if (json?.error) {
      console.error("[igaudio] 검색 실패:", String(json.error.message ?? "").slice(0, 120));
      return null;
    }
    const list: any[] = Array.isArray(json?.data) ? json.data : [];
    if (!list.length) {
      // 2026-08-21 실측: 권한·토큰·앱 라이브 상태 모두 정상인데 카탈로그가 0곡.
      // 크리에이터 전환 반영 대기 또는 한국 계정 미개방으로 추정 — 열리면 이 로그가 사라진다.
      console.log("[igaudio] 카탈로그 0곡 — CC BGM 폴백 (계정/지역 개방 대기 중)");
      return null;
    }
    // 최상위 1곡 고정이 아니라 상위 10곡 랜덤 — 매일 같은 곡 반복을 피한다
    const a = list.slice(0, 10)[Math.floor(Math.random() * Math.min(10, list.length))];
    if (!a?.id) return null;
    return {
      id: String(a.id),
      title: a.title ?? a.name ?? undefined,
      artist: a.display_artist ?? a.artist_name ?? a.artist ?? undefined,
    };
  } catch (e) {
    console.error("[igaudio] 검색 오류:", String(e).slice(0, 120));
    return null;
  }
}
