// Meta Instagram Graph API — 공식 API만 사용 (비공식 자동화는 계정 정지 사유)
const GRAPH = "https://graph.facebook.com/v23.0";

function token() {
  return process.env.IG_ACCESS_TOKEN!;
}
function igUserId() {
  return process.env.IG_USER_ID!;
}

async function graphPost(path: string, body: Record<string, unknown>) {
  const res = await fetch(`${GRAPH}/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token()}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const json = await res.json();
  if (!res.ok || json.error) {
    throw new Error(`Graph API ${path}: ${JSON.stringify(json.error ?? json)}`);
  }
  return json;
}

/** 이미지 게시: 컨테이너 생성 → 발행. 발행된 media id 반환 */
export async function publishImage(imageUrl: string, caption: string): Promise<string> {
  const container = await graphPost(`${igUserId()}/media`, {
    image_url: imageUrl,
    caption,
  });

  // 컨테이너 처리 대기 (이미지 다운로드/검증에 몇 초 걸릴 수 있음)
  for (let i = 0; i < 10; i++) {
    const status = await fetch(
      `${GRAPH}/${container.id}?fields=status_code&access_token=${token()}`
    ).then((r) => r.json());
    if (status.status_code === "FINISHED") break;
    if (status.status_code === "ERROR") {
      throw new Error(`컨테이너 처리 실패: ${JSON.stringify(status)}`);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }

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
