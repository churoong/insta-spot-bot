import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { db, initDb } from "@/lib/db";
import { buildDmText, buildReplyText } from "@/lib/caption";
import { sendPrivateReply, replyToComment } from "@/lib/instagram";
import { fetchNearby } from "@/lib/tourapi";

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
  await initDb();

  const notes: string[] = [];
  const log = (n: string) => notes.push(n);

  // 서명 검증 (요청이 진짜 Meta에서 왔는지) — 검증 실패 시 차단
  const sig = req.headers.get("x-hub-signature-256") ?? "";
  let sigOk = false;
  try {
    const expected =
      "sha256=" +
      crypto.createHmac("sha256", process.env.META_APP_SECRET ?? "").update(raw).digest("hex");
    sigOk =
      !!sig &&
      sig.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    /* 시크릿 없거나 형식 오류 */
  }
  if (!sigOk) {
    return NextResponse.json({ error: "bad signature" }, { status: 403 });
  }

  const keyword = process.env.DM_KEYWORD || "어디야";
  let body: any = {};
  try {
    body = JSON.parse(raw);
  } catch {
    log("JSON 파싱 실패");
  }

  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      log(`field=${change.field}`);
      if (change.field !== "comments") continue;
      const v = change.value ?? {};
      const commentId: string = v.id;
      const text: string = v.text ?? "";
      const mediaId: string = v.media?.id ?? "";
      const fromId: string = v.from?.id ?? "";
      const username: string = v.from?.username ?? "";
      log(`text="${text}" media=${mediaId} from=${fromId}/@${username}`);

      if (fromId === process.env.IG_USER_ID) { log("skip: 내 계정 댓글"); continue; }
      if (!text.includes(keyword)) { log("skip: 키워드 없음"); continue; }

      const seen = await db.execute({
        sql: "SELECT 1 FROM dm_log WHERE comment_id = ?",
        args: [commentId],
      });
      if (seen.rows.length > 0) { log("skip: 이미 발송함"); continue; }

      const post = await db.execute({
        sql: "SELECT place_name, address, category, mapx, mapy FROM posts WHERE ig_media_id = ?",
        args: [mediaId],
      });
      if (post.rows.length === 0) { log(`skip: 게시물 못찾음(media=${mediaId})`); continue; }

      try {
        // 근처 추천 2곳 (좌표 있을 때만, 실패해도 DM은 발송)
        const p = post.rows[0] as any;
        const nearby =
          p.mapx && p.mapy ? await fetchNearby(String(p.mapx), String(p.mapy), String(p.place_name)) : [];
        await sendPrivateReply(commentId, buildDmText(p, nearby));
        await db.execute({
          sql: "INSERT INTO dm_log (comment_id, ig_media_id, username) VALUES (?, ?, ?)",
          args: [commentId, mediaId, username],
        });
        log("✅ DM 발송 성공");
        // 공개 대댓글로도 안내 (자연스러운 문구 + 이모지)
        try {
          await replyToComment(commentId, buildReplyText());
          log("✅ 대댓글 성공");
        } catch (e) {
          log("대댓글 실패(무시): " + String(e).slice(0, 150));
        }
      } catch (e) {
        log("❌ DM 발송 실패: " + String(e).slice(0, 300));
      }
    }
  }

  // 진단 기록
  await db
    .execute({
      sql: "INSERT INTO webhook_debug (sig_ok, note, raw) VALUES (?, ?, ?)",
      args: [sigOk ? 1 : 0, notes.join(" | ") || "(no comment changes)", raw.slice(0, 3000)],
    })
    .catch(() => {});

  return NextResponse.json({ ok: true });
}
