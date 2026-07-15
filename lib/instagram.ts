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
      `${GRAPH}/${id}?fields=status_code&access_token=${await getToken()}`
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

  // 3) 발행
  const published = await graphPost(`${igUserId()}/media_publish`, {
    creation_id: carousel.id,
  });
  return String(published.id);
}

/** 이미지 게시: 컨테이너 생성 → 발행. 발행된 media id 반환 */
export async function publishImage(imageUrl: string, caption: string): Promise<string> {
  const container = await graphPost(`${igUserId()}/media`, {
    image_url: imageUrl,
    caption,
  });

  // 컨테이너 처리 대기 (이미지 다운로드/검증에 몇 초 걸릴 수 있음)
  await waitForContainer(String(container.id));

  const published = await graphPost(`${igUserId()}/media_publish`, {
    creation_id: container.id,
  });
  return String(published.id);
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
