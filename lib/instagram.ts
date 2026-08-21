// Instagram API with Instagram Login (공식 API). graph.instagram.com 사용.
// 비공식 자동화는 계정 정지 사유이므로 절대 사용하지 않음.
import { db, initDb } from "./db";

const GRAPH = "https://graph.instagram.com/v23.0";

function igUserId() {
  return process.env.IG_USER_ID!;
}

// ===== 토큰 관리: DB에 보관 + 7일마다 자동 갱신(60일 만료 방지) =====
// 환경변수 IG_ACCESS_TOKEN은 최초 시드용. 이후에는 DB의 최신 토큰 사용.

let cachedToken: { value: string; at: number } | null = null;

async function getToken(): Promise<string> {
  // 1분 캐시 (한 요청 내 여러 호출에서 DB 왕복 줄임)
  if (cachedToken && Date.now() - cachedToken.at < 60_000) return cachedToken.value;
  await initDb();
  const r = await db.execute("SELECT value FROM config WHERE key = 'ig_token'");
  let tok = r.rows[0]?.value as string | undefined;
  if (!tok) {
    tok = process.env.IG_ACCESS_TOKEN!;
    await db.execute({
      sql: "INSERT OR REPLACE INTO config (key, value, updated_at) VALUES ('ig_token', ?, datetime('now'))",
      args: [tok],
    });
  }
  cachedToken = { value: tok, at: Date.now() };
  return tok;
}

/**
 * 토큰이 7일 이상 묵었으면 refresh해서 새 60일 토큰으로 교체.
 * 매시 크론이 호출 → 봇이 돌아가는 한 토큰이 만료되지 않음.
 * 실패해도 기존 토큰 유지 (만료 전까지 재시도 기회 많음).
 */
export async function maybeRefreshToken(): Promise<{ refreshed: boolean; note?: string }> {
  await initDb();
  const r = await db.execute("SELECT value, updated_at FROM config WHERE key = 'ig_token'");
  if (r.rows.length === 0) return { refreshed: false, note: "토큰 없음(첫 발행 시 시드됨)" };

  const updatedAt = new Date(String(r.rows[0].updated_at).replace(" ", "T") + "Z").getTime();
  const ageDays = (Date.now() - updatedAt) / 86_400_000;
  if (ageDays < 7) return { refreshed: false };

  const current = String(r.rows[0].value);
  const res = await fetch(
    `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(current)}`,
    { signal: AbortSignal.timeout(20000) }
  );
  const json = await res.json();
  if (!json.access_token) {
    return { refreshed: false, note: "갱신 실패: " + JSON.stringify(json.error ?? json).slice(0, 200) };
  }
  await db.execute({
    sql: "UPDATE config SET value = ?, updated_at = datetime('now') WHERE key = 'ig_token'",
    args: [json.access_token],
  });
  cachedToken = null;
  return { refreshed: true, note: `새 토큰 저장 (유효 ${Math.round((json.expires_in ?? 0) / 86400)}일)` };
}

async function graphPost(path: string, body: Record<string, unknown>) {
  // access_token은 쿼리 파라미터로, 본문은 JSON (graph.instagram.com 검증된 방식)
  const url = `${GRAPH}/${path}?access_token=${encodeURIComponent(await getToken())}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const json = await res.json();
  if (!res.ok || json.error) {
    throw new Error(`Graph API ${path}: ${JSON.stringify(json.error ?? json)}`);
  }
  return json;
}

/** 컨테이너가 발행 준비될 때까지 대기 */
async function waitForContainer(id: string) {
  for (let i = 0; i < 15; i++) {
    const status = await fetch(
      `${GRAPH}/${id}?fields=status_code&access_token=${await getToken()}`,
      { signal: AbortSignal.timeout(15000) }
    ).then((r) => r.json());
    if (status.status_code === "FINISHED") return;
    if (status.status_code === "ERROR") {
      throw new Error(`컨테이너 처리 실패: ${JSON.stringify(status)}`);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error("컨테이너 처리 시간 초과");
}

/**
 * 컨테이너 발행(media_publish) — IG의 두 가지 알려진 오동작 방어:
 *  - 2207027 "media not ready": 컨테이너가 FINISHED여도 발행이 잠깐 준비 전일 수 있음 → 재시도
 *  - 2207051 "action is blocked": 에러를 돌려주면서 실제로는 발행됨 → 최근 미디어로 확인
 */
async function publishContainer(creationId: string, verifyCaption?: string): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const published = await graphPost(`${igUserId()}/media_publish`, { creation_id: creationId });
      return String(published.id);
    } catch (e) {
      const msg = String(e);
      if (/2207027|not ready for publishing|not available/i.test(msg) && attempt < 4) {
        await new Promise((r) => setTimeout(r, 5000)); // 준비 대기 후 재시도
        continue;
      }
      if (verifyCaption) {
        const verified = await verifyRecentPublish(verifyCaption);
        if (verified) {
          console.log("[publish] 에러 응답이지만 실제 발행 확인됨:", verified);
          return verified;
        }
      }
      throw e;
    }
  }
  throw new Error("발행 재시도 초과");
}

/**
 * 캐러셀(여러 장) 게시: 각 이미지 자식 컨테이너 → 캐러셀 컨테이너 → 발행.
 * 이미지가 1장이면 단일 이미지로 게시.
 */
export async function publishCarousel(imageUrls: string[], caption: string): Promise<string> {
  if (imageUrls.length <= 1) {
    return publishImage(imageUrls[0], caption);
  }

  // 1) 자식 컨테이너들 병렬 생성 (캐러셀 항목) — 순차로 하면 Vercel 60초 초과
  const childIds: string[] = await Promise.all(
    imageUrls.slice(0, 10).map((url) =>
      graphPost(`${igUserId()}/media`, {
        image_url: url,
        is_carousel_item: true,
      }).then((c) => String(c.id))
    )
  );
  // 자식 컨테이너 처리 병렬 대기 (총 대기 = 가장 느린 1장, 합산 아님)
  await Promise.all(childIds.map((id) => waitForContainer(id)));

  // 2) 캐러셀 컨테이너 생성
  const carousel = await graphPost(`${igUserId()}/media`, {
    media_type: "CAROUSEL",
    caption,
    children: childIds,
  });
  await waitForContainer(carousel.id);

  // 3) 발행 (준비 안 됨 재시도 + 가짜 차단 검증은 publishContainer가 처리)
  return publishContainer(String(carousel.id), caption);
}

/**
 * media_publish가 에러를 반환했을 때, 방금 실제로 발행됐는지 최근 미디어를 조회해 확인.
 * 캡션 앞부분이 일치하고 3분 이내 게시물이면 그 media id 반환.
 */
async function verifyRecentPublish(caption: string): Promise<string | null> {
  try {
    await new Promise((r) => setTimeout(r, 8000)); // 반영 대기
    const res = await fetch(
      `${GRAPH}/${igUserId()}/media?fields=id,caption,timestamp&limit=3&access_token=${encodeURIComponent(await getToken())}`,
      { signal: AbortSignal.timeout(15000) }
    );
    const json = await res.json();
    const head = caption.slice(0, 40);
    for (const m of json?.data ?? []) {
      const age = Date.now() - new Date(m.timestamp).getTime();
      if (age < 3 * 60 * 1000 && String(m.caption ?? "").startsWith(head)) {
        return String(m.id);
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** 이미지 게시: 컨테이너 생성 → 발행. 발행된 media id 반환 */
export async function publishImage(imageUrl: string, caption: string): Promise<string> {
  const container = await graphPost(`${igUserId()}/media`, {
    image_url: imageUrl,
    caption,
  });

  // 컨테이너 처리 대기 (이미지 다운로드/검증에 몇 초 걸릴 수 있음)
  await waitForContainer(String(container.id));

  return publishContainer(String(container.id), caption);
}

/**
 * 릴스(동영상) 발행: video_url로 REELS 컨테이너 생성 → 처리 대기 → 발행.
 * 동영상은 이미지보다 처리 시간이 길어 대기를 넉넉히(최대 ~4분) 둔다.
 */
export async function publishReel(videoUrl: string, caption: string): Promise<string> {
  const container = await graphPost(`${igUserId()}/media`, {
    media_type: "REELS",
    video_url: videoUrl,
    caption,
    share_to_feed: true,
  });

  // 동영상 처리 대기 (인코딩 검증에 수십 초~수 분)
  const id = String(container.id);
  for (let i = 0; i < 80; i++) {
    const status = await fetch(
      `${GRAPH}/${id}?fields=status_code,status&access_token=${encodeURIComponent(await getToken())}`,
      { signal: AbortSignal.timeout(15000) }
    ).then((r) => r.json());
    if (status.status_code === "FINISHED") break;
    if (status.status_code === "ERROR") {
      throw new Error(`릴스 컨테이너 처리 실패: ${JSON.stringify(status)}`);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }

  return publishContainer(id, caption);
}

// ===== Facebook Login 발행 경로 (Instagram Audio API — 라이브러리 음악 첨부용) =====
// 2026-06 신설된 Audio API는 graph.facebook.com 전용이라, 음악을 붙일 때만 이 경로를
// 쓰고 실패하면 기존 Instagram Login 경로로 폴백한다. 토큰은 페이지 연동 장기 토큰
// (FB_ACCESS_TOKEN) — 장기 사용자 토큰에서 파생된 페이지 토큰은 만료되지 않는다.

const GRAPH_FB = "https://graph.facebook.com/v23.0";

function fbConfigured(): boolean {
  return Boolean(process.env.FB_ACCESS_TOKEN && process.env.FB_IG_USER_ID);
}

async function fbPost(path: string, params: Record<string, unknown>): Promise<any> {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    body.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
  }
  body.set("access_token", process.env.FB_ACCESS_TOKEN!);
  const res = await fetch(`${GRAPH_FB}/${path}`, {
    method: "POST",
    body,
    signal: AbortSignal.timeout(60000),
  });
  const json: any = await res.json();
  if (json?.error) throw new Error(`FB ${path}: ${JSON.stringify(json.error).slice(0, 300)}`);
  return json;
}

export interface ReelMusic {
  /** ig_audio 검색 결과의 오디오 ID */
  audioId: string;
  /** 라이브러리 음악 볼륨 0~100 (기본 100) */
  audioVolume?: number;
  /** 영상에 구운 오디오(나레이션) 볼륨 0~100 (기본 100) */
  videoVolume?: number;
}

/** graph.facebook.com으로 릴스 발행 — music이 있으면 audio_configuration 첨부 */
async function publishReelFb(videoUrl: string, caption: string, music: ReelMusic | null): Promise<string> {
  const igId = process.env.FB_IG_USER_ID!;
  const params: Record<string, unknown> = {
    media_type: "REELS",
    video_url: videoUrl,
    caption,
    share_to_feed: true,
  };
  if (music) {
    params.audio_configuration = {
      audio_id: music.audioId,
      ...(music.audioVolume !== undefined ? { audio_volume: music.audioVolume } : {}),
      ...(music.videoVolume !== undefined ? { video_volume: music.videoVolume } : {}),
    };
  }
  const container = await fbPost(`${igId}/media`, params);
  const id = String(container.id);
  for (let i = 0; i < 80; i++) {
    const status: any = await fetch(
      `${GRAPH_FB}/${id}?fields=status_code,status&access_token=${encodeURIComponent(process.env.FB_ACCESS_TOKEN!)}`,
      { signal: AbortSignal.timeout(15000) }
    ).then((r) => r.json());
    if (status.status_code === "FINISHED") break;
    if (status.status_code === "ERROR") {
      throw new Error(`FB 릴스 컨테이너 처리 실패: ${JSON.stringify(status).slice(0, 300)}`);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  const published = await fbPost(`${igId}/media_publish`, { creation_id: id });
  return String(published.id);
}

/**
 * 릴스 발행 진입점 — 음악이 있으면 FB 경로(음악 첨부), 실패 시 단계적 폴백:
 *   ① FB + 음악 → ② FB 음악 없이 → ③ 기존 Instagram Login 경로.
 * FB 미설정이거나 음악이 없으면 바로 ③.
 */
export async function publishReelSmart(
  videoUrl: string,
  caption: string,
  music: ReelMusic | null
): Promise<string> {
  if (music && fbConfigured()) {
    try {
      const id = await publishReelFb(videoUrl, caption, music);
      console.log("[publish] FB 경로 발행 (라이브러리 음악 첨부):", id);
      return id;
    } catch (e) {
      console.error("[publish] 음악 첨부 발행 실패 — 음악 없이 재시도:", String(e).slice(0, 200));
      try {
        const id = await publishReelFb(videoUrl, caption, null);
        console.log("[publish] FB 경로 발행 (음악 없음):", id);
        return id;
      } catch (e2) {
        console.error("[publish] FB 경로 실패 — Instagram Login으로 폴백:", String(e2).slice(0, 200));
      }
    }
  }
  return publishReel(videoUrl, caption);
}

/** 댓글에 대한 비공개 답장(Private Reply) — 댓글 작성자에게 DM 발송 */
export async function sendPrivateReply(commentId: string, text: string) {
  await graphPost(`${igUserId()}/messages`, {
    recipient: { comment_id: commentId },
    message: { text },
  });
}

/** (선택) 댓글에 공개 답글 달기 — DM 보냈다는 안내용 */
export async function replyToComment(commentId: string, text: string) {
  await graphPost(`${commentId}/replies`, { message: text });
}

/** 스토리 발행 (이미지) — 24시간 노출. 발행된 media id 반환 */
export async function publishStory(imageUrl: string): Promise<string> {
  const container = await graphPost(`${igUserId()}/media`, {
    image_url: imageUrl,
    media_type: "STORIES",
  });
  await waitForContainer(String(container.id));
  return publishContainer(String(container.id));
}

/** 팔로워 수 조회 (주간 리포트용) */
export async function fetchFollowers(): Promise<number | null> {
  try {
    const res = await fetch(
      `${GRAPH}/${igUserId()}?fields=followers_count&access_token=${encodeURIComponent(await getToken())}`,
      { signal: AbortSignal.timeout(15000) }
    );
    const json = await res.json();
    if (json.error) return null;
    return Number(json.followers_count ?? 0);
  } catch {
    return null;
  }
}

/** 게시물 반응 수 조회 (좋아요·댓글) — 인기 랭킹·주간 베스트용 */
export async function fetchEngagement(
  mediaId: string
): Promise<{ likes: number; comments: number } | null> {
  try {
    const res = await fetch(
      `${GRAPH}/${mediaId}?fields=like_count,comments_count&access_token=${encodeURIComponent(await getToken())}`,
      { signal: AbortSignal.timeout(15000) }
    );
    const json = await res.json();
    if (json.error) return null;
    return {
      likes: Number(json.like_count ?? 0),
      comments: Number(json.comments_count ?? 0),
    };
  } catch {
    return null;
  }
}
