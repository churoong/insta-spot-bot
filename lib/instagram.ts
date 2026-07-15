// Instagram API with Instagram Login (공식 API). graph.instagram.com 사용.
// 비공식 자동화는 계정 정지 사유이므로 절대 사용하지 않음.
const GRAPH = "https://graph.instagram.com/v23.0";

function token() {
  return process.env.IG_ACCESS_TOKEN!;
}
function igUserId() {
  return process.env.IG_USER_ID!;
}

async function graphPost(path: string, body: Record<string, unknown>) {
  // access_token은 쿼리 파라미터로, 본문은 JSON (graph.instagram.com 검증된 방식)
  const url = `${GRAPH}/${path}?access_token=${encodeURIComponent(token())}`;
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
      `${GRAPH}/${id}?fields=status_code&access_token=${token()}`
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

  // 1) 자식 컨테이너들 생성 (캐러셀 항목)
  const childIds: string[] = [];
  for (const url of imageUrls.slice(0, 10)) {
    const child = await graphPost(`${igUserId()}/media`, {
      image_url: url,
      is_carousel_item: true,
    });
    childIds.push(child.id);
  }
  // 자식 컨테이너 처리 대기
  for (const id of childIds) await waitForContainer(id);

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
