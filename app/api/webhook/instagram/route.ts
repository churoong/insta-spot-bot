import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { db, initDb } from "@/lib/db";
import { buildDmText } from "@/lib/caption";
import { sendPrivateReply, replyToComment } from "@/lib/instagram";

export const maxDuration = 30;

// Meta 웹훅 구독 검증 (앱 설정에서 웹훅 등록 시 1회 호출됨)
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  if (
    sp.get("hub.mode") === "subscribe" &&
    sp.get("hub.verify_token") === process.env.WEBHOOK_VERIFY_TOKEN
  ) {
    return new Response(sp.get("hub.challenge") ?? "", { status: 200 });
  }
  return NextResponse.json({ error: "verification failed" }, { status: 403 });
}

// 댓글 이벤트 수신 → 키워드 매칭 → Private Reply로 DM 발송
export async function POST(req: NextRequest) {
  const raw = await req.text();

  // 서명 검증 (요청이 진짜 Meta에서 왔는지)
  const sig = req.headers.get("x-hub-signature-256") ?? "";
  const expected =
    "sha256=" +
    crypto.createHmac("sha256", process.env.META_APP_SECRET!).update(raw).digest("hex");
  if (!sig || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return NextResponse.json({ error: "bad signature" }, { status: 403 });
  }

  await initDb();
  const body = JSON.parse(raw);
  const keyword = process.env.DM_KEYWORD || "어디야";

  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "comments") continue;
      const v = change.value;
      const commentId: string = v.id;
      const text: string = v.text ?? "";
      const mediaId: string = v.media?.id ?? "";
      const fromId: string = v.from?.id ?? "";
      const username: string = v.from?.username ?? "";

      // 내 계정이 단 댓글(답글 등)은 무시 — 무한루프 방지
      if (fromId === process.env.IG_USER_ID) continue;
      // 키워드 미포함 댓글은 무시
      if (!text.includes(keyword)) continue;

      // 중복 발송 방지
      const seen = await db.execute({
        sql: "SELECT 1 FROM dm_log WHERE comment_id = ?",
        args: [commentId],
      });
      if (seen.rows.length > 0) continue;

      // 어떤 게시글의 댓글인지 → 장소 정보 조회
      const post = await db.execute({
        sql: "SELECT place_name, address, category FROM posts WHERE ig_media_id = ?",
        args: [mediaId],
      });
      if (post.rows.length === 0) continue;

      try {
        await sendPrivateReply(commentId, buildDmText(post.rows[0] as any));
        await db.execute({
          sql: "INSERT INTO dm_log (comment_id, ig_media_id, username) VALUES (?, ?, ?)",
          args: [commentId, mediaId, username],
        });
        // 댓글에도 답글로 안내 (다른 사람들의 참여 유도)
        try {
          await replyToComment(commentId, "DM으로 보내드렸어요! 확인해 주세요 📩");
        } catch {
          /* 답글 실패는 무시 */
        }
      } catch (e) {
        console.error("DM 발송 실패:", commentId, e);
      }
    }
  }

  // Meta는 200 응답을 못 받으면 재시도하므로 항상 200
  return NextResponse.json({ ok: true });
}
