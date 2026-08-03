import { after, NextRequest, NextResponse } from "next/server";
import { db, initDb } from "@/lib/db";
import { buildWeeklyCaption } from "@/lib/caption";
import { publishCarousel } from "@/lib/instagram";

export const maxDuration = 300;

// 주 1회(일요일 저녁 권장) 외부 크론이 호출:
// GET /api/cron/weekly  (Authorization: Bearer $CRON_SECRET)
// ?dry=1 을 붙이면 실제 발행 없이 선정 결과만 반환 (테스트용)
// 발행은 오래 걸리므로 즉시 응답 후 after()로 백그라운드 처리 (dry/sync 제외).
export async function GET(req: NextRequest) {
  if (req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const dry = req.nextUrl.searchParams.get("dry") === "1";
  const sync = req.nextUrl.searchParams.get("sync") === "1";

  if (dry || sync) {
    return NextResponse.json(await runWeekly(dry));
  }
  after(async () => {
    try {
      console.log("[cron/weekly]", JSON.stringify(await runWeekly(false)));
    } catch (e) {
      console.error("[cron/weekly] 오류:", e);
    }
  });
  return NextResponse.json({ accepted: true });
}

async function runWeekly(dry: boolean) {
  await initDb();

  // 이번 주 식별자 (중복 발행 방지) — ISO 주차 + ISO 주-연도 사용
  // (연말 ISO 1주차가 다음 해로 넘어갈 때 달력연도를 쓰면 ID가 충돌/누락됨)
  const now = new Date();
  const iso = isoWeek(now);
  const weekId = `weekly-${iso.year}-${iso.week}`;
  const dup = await db.execute({
    sql: "SELECT 1 FROM posts WHERE content_id = ?",
    args: [weekId],
  });
  if (dup.rows.length > 0) {
    return { skipped: true, reason: "이번 주 베스트는 이미 발행됨" };
  }

  // 릴스 전용 모드: 주간 베스트는 캐러셀이라 Vercel(ffmpeg 없음)에서 릴스로 못 만듦.
  // 릴스 전용 정책에선 발행하지 않는다. FEED_CAROUSEL=1 로 다시 켤 수 있음.
  if (process.env.FEED_CAROUSEL !== "1") {
    return { skipped: true, reason: "릴스 전용 모드 — 주간 캐러셀 발행 안 함" };
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
    return { skipped: true, reason: `지난 7일 발행 게시물이 부족함(${top.rows.length}건)` };
  }

  const rows = top.rows as any[];
  const images = rows.map((r) => String(r.image_url)).filter((u) => u && u !== "null");
  if (images.length === 0) {
    return { skipped: true, reason: "TOP 게시물에 사용할 이미지가 없음" };
  }
  const caption = buildWeeklyCaption(rows.length);

  // DM 응답용: 웹훅의 buildDmText가 place_name/address를 그대로 출력하므로
  // TOP3 전체를 담아 저장 → "어디야" 댓글에 3곳 모두 DM으로 전달됨
  const dmName = `이번 주 베스트 TOP${rows.length}`;
  const dmAddress = rows
    .map((r, i) => `${i + 1}위 ${r.place_name} — ${r.address}`)
    .join("\n");

  if (dry) {
    return {
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
    };
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

  return {
    published: !dryRun,
    weekId,
    top: rows.map((r, i) => `${i + 1}위 ${r.place_name}`),
    mediaId,
  };
}

/** ISO 8601 주차 + 주-연도 (목요일 기준으로 해가 결정됨) */
function isoWeek(d: Date): { year: number; week: number } {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum); // 그 주의 목요일로 이동
  const isoYear = date.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return { year: isoYear, week };
}
