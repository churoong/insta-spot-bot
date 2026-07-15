import { after, NextRequest, NextResponse } from "next/server";
import { db, initDb } from "@/lib/db";
import { fetchCandidates, fetchOverview, fetchImages, MIN_IMAGES } from "@/lib/tourapi";
import { generateCaption } from "@/lib/caption";
import { publishCarousel, maybeRefreshToken, fetchEngagement } from "@/lib/instagram";
import { pickFeatured } from "@/lib/featured";

export const maxDuration = 60;

// 외부 크론(cron-job.org 등)이 호출:
// GET /api/cron/post  (Authorization: Bearer $CRON_SECRET)
//
// 발행(인스타 컨테이너 처리)은 40초+ 걸려 cron-job.org의 30초 타임아웃에 걸림.
// → 즉시 200 응답하고 실제 작업은 after()로 백그라운드 처리(최대 maxDuration까지).
// 테스트 시 ?sync=1 을 붙이면 동기 실행 후 결과를 반환.
export async function GET(req: NextRequest) {
  if (req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // ?featured=1 → 인증맛집 회차 강제 (테스트용)
  const forceFeatured = req.nextUrl.searchParams.get("featured") === "1";

  if (req.nextUrl.searchParams.get("sync") === "1") {
    const result = await runCron(forceFeatured);
    return NextResponse.json(result);
  }

  // cron-job.org에는 즉시 응답, 발행은 백그라운드에서
  after(async () => {
    try {
      const r = await runCron(forceFeatured);
      console.log("[cron/post]", JSON.stringify(r));
    } catch (e) {
      console.error("[cron/post] 오류:", e);
    }
  });
  return NextResponse.json({ accepted: true });
}

async function runCron(forceFeatured = false) {
  await initDb();

  // 토큰 자동 갱신: 7일 넘게 묵었으면 새 60일 토큰으로 교체 (실패해도 발행은 계속)
  try {
    const tr = await maybeRefreshToken();
    if (tr.note) console.log("[token]", tr.refreshed ? "갱신됨:" : "", tr.note);
  } catch (e) {
    console.error("[token] 갱신 중 오류(무시):", e);
  }

  // 최근 발행 게시물의 반응 수(좋아요·댓글) 수집 — 인기 랭킹·주간 베스트용
  if (process.env.IG_ACCESS_TOKEN) {
    try {
      const recent = await db.execute(
        "SELECT id, ig_media_id FROM posts WHERE status='published' AND ig_media_id IS NOT NULL ORDER BY id DESC LIMIT 10"
      );
      await Promise.all(
        recent.rows.map(async (r: any) => {
          const eng = await fetchEngagement(String(r.ig_media_id));
          if (eng) {
            await db.execute({
              sql: "UPDATE posts SET like_count = ?, comment_count = ? WHERE id = ?",
              args: [eng.likes, eng.comments, r.id],
            });
          }
        })
      );
    } catch (e) {
      console.error("[engagement] 수집 오류(무시):", e);
    }
  }

  // 일일 발행 한도 체크 (Graph API 한도 50/일, 기본 24/일)
  const limit = Number(process.env.POSTS_PER_DAY_LIMIT || 24);
  const today = await db.execute(
    "SELECT COUNT(*) AS n FROM posts WHERE created_at >= datetime('now', '-1 day')"
  );
  if (Number(today.rows[0].n) >= limit) {
    return { skipped: true, reason: "daily limit reached" };
  }

  // 인증맛집 회차: 매 FEATURED_EVERY번째(기본 4) 게시물, 또는 ?featured=1 강제.
  // 목록에서 못 찾으면 일반 발행으로 자연스럽게 진행.
  const FEATURED_EVERY = Number(process.env.FEATURED_EVERY || 4);
  const total = Number(
    (await db.execute("SELECT COUNT(*) AS n FROM posts")).rows[0].n
  );
  if (forceFeatured || (FEATURED_EVERY > 0 && total % FEATURED_EVERY === FEATURED_EVERY - 1)) {
    try {
      const f = await pickFeatured();
      if (f) {
        f.spot.overview = await fetchOverview(f.spot.contentId);
        const { caption } = await generateCaption(f.spot, { featuredBy: f.label });
        return await publishAndSave(f.spot, caption, f.label);
      }
      console.log("[featured] 후보 없음 → 일반 발행으로 진행");
    } catch (e) {
      console.error("[featured] 오류(일반 발행으로 진행):", e);
    }
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
      return await publishAndSave(spot, caption, null);
    }
  }

  return { published: false, reason: "no new candidates found" };
}

/** 발행(또는 드라이런) 후 DB 저장 — 일반/인증맛집 공용 */
async function publishAndSave(
  spot: import("@/lib/tourapi").Spot,
  caption: string,
  featuredBy: string | null
) {
  // Meta 토큰이 아직 없으면 드라이런: 캡션·이미지만 저장하고 실제 업로드는 건너뜀.
  const dryRun = !process.env.IG_ACCESS_TOKEN || !process.env.IG_USER_ID;
  const mediaId = dryRun ? null : await publishCarousel(spot.imageUrls, caption);

  await db.execute({
    sql: `INSERT INTO posts (content_id, place_name, address, category, image_url, image_urls, caption, ig_media_id, status, mapx, mapy, featured_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      spot.mapx ?? null,
      spot.mapy ?? null,
      featuredBy,
    ],
  });

  return {
    published: !dryRun,
    dryRun,
    place: spot.name,
    images: spot.imageUrls.length,
    featured: !!featuredBy,
    mediaId,
  };
}
