import { NextRequest, NextResponse } from "next/server";
import { db, initDb } from "@/lib/db";
import { fetchCandidates, fetchOverview, fetchImages, MIN_IMAGES } from "@/lib/tourapi";
import { generateCaption } from "@/lib/caption";
import { publishCarousel, maybeRefreshToken } from "@/lib/instagram";

export const maxDuration = 60;

// 1시간에 한 번 외부 크론(cron-job.org 등)이 호출:
// GET /api/cron/post  (Authorization: Bearer $CRON_SECRET)
export async function GET(req: NextRequest) {
  if (req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  await initDb();

  // 토큰 자동 갱신: 7일 넘게 묵었으면 새 60일 토큰으로 교체 (실패해도 발행은 계속)
  try {
    const tr = await maybeRefreshToken();
    if (tr.note) console.log("[token]", tr.refreshed ? "갱신됨:" : "", tr.note);
  } catch (e) {
    console.error("[token] 갱신 중 오류(무시):", e);
  }

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

      // 캐러셀용 이미지 수집 — 최소 장수 미달이면 이 후보는 건너뜀
      spot.imageUrls = await fetchImages(spot.contentId, spot.imageUrl);
      if (spot.imageUrls.length < MIN_IMAGES) continue;

      spot.overview = await fetchOverview(spot.contentId);
      const { caption } = await generateCaption(spot);

      // Meta 토큰이 아직 없으면 드라이런: 캡션·이미지만 저장하고 실제 업로드는 건너뜀.
      const dryRun = !process.env.IG_ACCESS_TOKEN || !process.env.IG_USER_ID;
      const mediaId = dryRun ? null : await publishCarousel(spot.imageUrls, caption);

      await db.execute({
        sql: `INSERT INTO posts (content_id, place_name, address, category, image_url, image_urls, caption, ig_media_id, status)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          spot.contentId,
          spot.name,
          spot.address,
          spot.category,
          spot.imageUrl,
          JSON.stringify(spot.imageUrls),
          caption,
          mediaId,
          dryRun ? "dry_run" : "published",
        ],
      });

      return NextResponse.json({
        published: !dryRun,
        dryRun,
        place: spot.name,
        images: spot.imageUrls.length,
        mediaId,
      });
    }
  }

  return NextResponse.json(
    { published: false, reason: "no new candidates found" },
    { status: 500 }
  );
}
