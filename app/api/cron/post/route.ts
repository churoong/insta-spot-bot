import { NextRequest, NextResponse } from "next/server";
import { db, initDb } from "@/lib/db";
import { fetchCandidates, fetchOverview } from "@/lib/tourapi";
import { generateCaption } from "@/lib/caption";
import { publishImage } from "@/lib/instagram";

export const maxDuration = 60;

// 1시간에 한 번 외부 크론(cron-job.org 등)이 호출:
// GET /api/cron/post  (Authorization: Bearer $CRON_SECRET)
export async function GET(req: NextRequest) {
  if (req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  await initDb();

  // 일일 발행 한도 체크 (Graph API 한도 50/일, 기본 24/일)
  const limit = Number(process.env.POSTS_PER_DAY_LIMIT || 24);
  const today = await db.execute(
    "SELECT COUNT(*) AS n FROM posts WHERE created_at >= datetime('now', '-1 day')"
  );
  if (Number(today.rows[0].n) >= limit) {
    return NextResponse.json({ skipped: true, reason: "daily limit reached" });
  }

  // 아직 안 올린 장소 찾기 (최대 3번 다른 지역 시도)
  for (let attempt = 0; attempt < 3; attempt++) {
    const candidates = await fetchCandidates();
    for (const spot of candidates.sort(() => Math.random() - 0.5)) {
      const dup = await db.execute({
        sql: "SELECT 1 FROM posts WHERE content_id = ?",
        args: [spot.contentId],
      });
      if (dup.rows.length > 0) continue;

      spot.overview = await fetchOverview(spot.contentId);
      const { caption } = await generateCaption(spot);

      // Meta 토큰이 아직 없으면 드라이런: 캡션만 생성·저장하고 실제 업로드는 건너뜀.
      // 계정 준비 전에 대시보드에서 실제 결과물을 미리 확인할 수 있음.
      const dryRun = !process.env.IG_ACCESS_TOKEN || !process.env.IG_USER_ID;
      const mediaId = dryRun ? null : await publishImage(spot.imageUrl, caption);

      await db.execute({
        sql: `INSERT INTO posts (content_id, place_name, address, category, image_url, caption, ig_media_id, status)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          spot.contentId,
          spot.name,
          spot.address,
          spot.category,
          spot.imageUrl,
          caption,
          mediaId,
          dryRun ? "dry_run" : "published",
        ],
      });

      return NextResponse.json({
        published: !dryRun,
        dryRun,
        place: spot.name,
        mediaId,
      });
    }
  }

  return NextResponse.json(
    { published: false, reason: "no new candidates found" },
    { status: 500 }
  );
}
