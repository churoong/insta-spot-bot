import { NextRequest, NextResponse } from "next/server";
import { db, initDb } from "@/lib/db";
import { buildWeeklyCaption } from "@/lib/caption";
import { publishCarousel } from "@/lib/instagram";

export const maxDuration = 60;

// 주 1회(일요일 저녁 권장) 외부 크론이 호출:
// GET /api/cron/weekly  (Authorization: Bearer $CRON_SECRET)
// ?dry=1 을 붙이면 실제 발행 없이 선정 결과만 반환 (테스트용)
export async function GET(req: NextRequest) {
  if (req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const dry = req.nextUrl.searchParams.get("dry") === "1";

  await initDb();

  // 이번 주 식별자 (중복 발행 방지)
  const now = new Date();
  const weekId = `weekly-${now.getUTCFullYear()}-${getWeek(now)}`;
  const dup = await db.execute({
    sql: "SELECT 1 FROM posts WHERE content_id = ?",
    args: [weekId],
  });
  if (dup.rows.length > 0) {
    return NextResponse.json({ skipped: true, reason: "이번 주 베스트는 이미 발행됨" });
  }

  // 지난 7일 발행 게시물 중 반응(좋아요 + 댓글×3) TOP3 선정
  const top = await db.execute(
    `SELECT place_name, address, category, image_url,
            like_count, comment_count,
            (COALESCE(like_count,0) + COALESCE(comment_count,0) * 3) AS score
     FROM posts
     WHERE status = 'published'
       AND category != '주간베스트'
       AND created_at >= datetime('now', '-7 days')
     ORDER BY score DESC, id DESC
     LIMIT 3`
  );
  if (top.rows.length < 2) {
    return NextResponse.json(
      { skipped: true, reason: `지난 7일 발행 게시물이 부족함(${top.rows.length}건)` },
      { status: 200 }
    );
  }

  const rows = top.rows as any[];
  const images = rows.map((r) => String(r.image_url)).filter(Boolean);
  const caption = buildWeeklyCaption(rows.length);

  // DM 응답용: 웹훅의 buildDmText가 place_name/address를 그대로 출력하므로
  // TOP3 전체를 담아 저장 → "어디야" 댓글에 3곳 모두 DM으로 전달됨
  const dmName = `이번 주 베스트 TOP${rows.length}`;
  const dmAddress = rows
    .map((r, i) => `${i + 1}위 ${r.place_name} — ${r.address}`)
    .join("\n");

  if (dry) {
    return NextResponse.json({
      dry: true,
      weekId,
      top: rows.map((r, i) => ({
        rank: i + 1,
        place: r.place_name,
        likes: r.like_count,
        comments: r.comment_count,
      })),
      images: images.length,
      caption,
    });
  }

  const dryRun = !process.env.IG_ACCESS_TOKEN || !process.env.IG_USER_ID;
  const mediaId = dryRun ? null : await publishCarousel(images, caption);

  await db.execute({
    sql: `INSERT INTO posts (content_id, place_name, address, category, image_url, image_urls, caption, ig_media_id, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      weekId,
      dmName,
      dmAddress,
      "주간베스트",
      images[0] ?? null,
      JSON.stringify(images),
      caption,
      mediaId,
      dryRun ? "dry_run" : "published",
    ],
  });

  return NextResponse.json({
    published: !dryRun,
    weekId,
    top: rows.map((r, i) => `${i + 1}위 ${r.place_name}`),
    mediaId,
  });
}

/** ISO 주차 번호 */
function getWeek(d: Date): number {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}
