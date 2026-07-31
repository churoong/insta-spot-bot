import { after, NextRequest, NextResponse } from "next/server";
import { db, initDb } from "@/lib/db";
import { fetchCandidates, fetchByFoodKeyword, fetchOverview, fetchFoodInfo, fetchQuizImages, MIN_IMAGES } from "@/lib/tourapi";
import { generateCaption } from "@/lib/caption";
import { publishCarousel, publishStory, maybeRefreshToken, fetchEngagement, fetchFollowers } from "@/lib/instagram";
import { pickFeatured } from "@/lib/featured";
import { findPlace, mapLink, pickKakaoSpot, searchMapUrl } from "@/lib/kakao";
import { standardizePhotos } from "@/lib/photo";
import { pickPerformingKeyword } from "@/lib/performance";

// Fluid compute 기준 Hobby 최대 300초 — 발행+인증맛집 탐색이 60초를 넘는 경우 대비
export const maxDuration = 300;

// 캐러셀 표지 훅 문구 — 이모지 없이(번들 한글 폰트엔 이모지 글리프 없음). 저장·정지 유도.
const COVER_HOOKS = [
  "저장 안 하면 후회해요", "현지인만 아는 그 맛", "여기 진짜 맛집이에요",
  "이건 무조건 저장각", "숨은 맛집 찾았어요", "아는 사람만 가는 곳",
  "줄 서서 먹는 그 집", "이 맛, 꼭 저장하세요",
];

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

  // ?resetcooldown=1 → 발행 쿨다운 수동 해제 (차단 풀린 걸 확인했을 때)
  if (req.nextUrl.searchParams.get("resetcooldown") === "1") {
    await initDb();
    await db.execute("DELETE FROM config WHERE key='publish_cooldown_until'");
    return NextResponse.json({ ok: true, reset: "publish_cooldown_until 해제됨" });
  }

  // ?featured=1 → 인증맛집 회차 강제 (테스트용)
  const forceFeatured = req.nextUrl.searchParams.get("featured") === "1";

  if (req.nextUrl.searchParams.get("sync") === "1") {
    try {
      const result = await runCron(forceFeatured);
      await clog("sync 완료: " + JSON.stringify(result));
      return NextResponse.json(result);
    } catch (e) {
      await clog("sync 실패: " + String(e).slice(0, 400));
      return NextResponse.json({ error: String(e).slice(0, 500) }, { status: 500 });
    }
  }

  // cron-job.org에는 즉시 응답, 발행은 백그라운드에서
  after(async () => {
    try {
      const r = await runCron(forceFeatured);
      await clog("완료: " + JSON.stringify(r));
      console.log("[cron/post]", JSON.stringify(r));
    } catch (e) {
      await clog("실패: " + String(e).slice(0, 400));
      console.error("[cron/post] 오류:", e);
    }
  });
  return NextResponse.json({ accepted: true });
}

/** 크론 실행 기록 + (진짜) API 요청 한도 감지 시에만 짧게 발행 백오프 */
async function clog(note: string) {
  try {
    await initDb();
    await db.execute({ sql: "INSERT INTO cron_log (note) VALUES (?)", args: [note.slice(0, 500)] });
    // ⚠️ "action is blocked"(code 4, subcode 2207051)은 가짜 신호 — 에러를 돌려주면서도
    //   실제로는 발행이 완료됨(verifyRecentPublish가 성공 처리). 따라서 쿨다운을 걸지 않는다.
    //   진짜로 백오프가 필요한 건 앱 API 요청 한도(rate limit)뿐이고, 이건 보통 1시간 내
    //   리셋되므로 짧게만 쉰다(과거 24h 고정은 발행을 과하게 멈췄음).
    if (/request limit reached/i.test(note)) {
      const hours = Number(process.env.PUBLISH_COOLDOWN_HOURS || 1);
      await db.execute({
        sql: "INSERT OR REPLACE INTO config (key, value, updated_at) VALUES ('publish_cooldown_until', datetime('now', ?), datetime('now'))",
        args: [`+${hours} hours`],
      });
    }
  } catch {
    /* 로그 실패는 무시 */
  }
}

async function runCron(forceFeatured = false) {
  await initDb();

  // 팔로워 수 일일 스냅샷 (주간 리포트용, 읽기 호출이라 차단·쿨다운과 무관)
  try {
    const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10); // KST 날짜
    const seen = await db.execute({ sql: "SELECT 1 FROM follower_log WHERE date = ?", args: [today] });
    if (seen.rows.length === 0 && process.env.IG_ACCESS_TOKEN) {
      const n = await fetchFollowers();
      if (n !== null) {
        await db.execute({ sql: "INSERT OR REPLACE INTO follower_log (date, count) VALUES (?, ?)", args: [today, n] });
      }
    }
  } catch { /* 스냅샷 실패 무시 */ }

  // 한국시간 심야(00~07시)에는 발행하지 않음 — 도달률 낮고 스팸으로 보일 수 있음.
  // QUIET_HOURS_OFF=1 로 끌 수 있음. (크론 스케줄러가 어느 시간대든 안전)
  const kstHour = (new Date().getUTCHours() + 9) % 24;
  if (process.env.QUIET_HOURS_OFF !== "1" && !forceFeatured && kstHour < 8) {
    return { skipped: true, reason: `KST 심야(${kstHour}시) — 발행 쉬는 시간` };
  }

  // 발행 쿨다운: 진짜 API 요청 한도(rate limit)가 감지되면 clog가 짧게 설정.
  // 그 시각까지 발행 시도를 쉬어 한도 초과 호출을 줄임.
  try {
    const cd = await db.execute("SELECT value FROM config WHERE key='publish_cooldown_until'");
    if (cd.rows.length > 0) {
      const until = new Date(String(cd.rows[0].value).replace(" ", "T") + "Z").getTime();
      if (Date.now() < until) {
        return {
          skipped: true,
          reason: `발행 쿨다운 (API 요청 한도 회복 대기, ${Math.round((until - Date.now()) / 60000)}분 남음)`,
        };
      }
    }
  } catch {
    /* 조회 실패 시 정상 진행 */
  }

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
        "SELECT id, ig_media_id FROM posts WHERE status='published' AND ig_media_id IS NOT NULL ORDER BY id DESC LIMIT 6"
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
  // dry_run(미리보기)은 실제 인스타 발행이 아니므로 제외
  const limit = Number(process.env.POSTS_PER_DAY_LIMIT || 24);
  const today = await db.execute(
    "SELECT COUNT(*) AS n FROM posts WHERE status='published' AND created_at >= datetime('now', '-1 day')"
  );
  if (Number(today.rows[0].n) >= limit) {
    return { skipped: true, reason: "daily limit reached" };
  }

  // 인증맛집 회차: 평균 FEATURED_EVERY(기본 4)번에 1번꼴 확률 방식, 또는 ?featured=1 강제.
  // (총 개수 % N 방식은 실패 시 같은 조건이 반복돼 발행이 고착되는 문제가 있어 확률로 변경)
  const FEATURED_EVERY = Number(process.env.FEATURED_EVERY || 4);
  if (forceFeatured || (FEATURED_EVERY > 0 && Math.random() < 1 / FEATURED_EVERY)) {
    try {
      const f = await pickFeatured();
      if (f) {
        f.spot.overview = await fetchOverview(f.spot.contentId);
        const info = await fetchFoodInfo(f.spot.contentId);
        const cap = await generateCaption(f.spot, { featuredBy: f.label, menu: info.menu, hours: info.hours });
        if (!cap) return { skipped: true, reason: "AI 한도 소진 — 이번 회차 발행 건너뜀" };
        return await publishAndSave(f.spot, cap.caption, f.label);
      }
      console.log("[featured] 후보 없음 → 일반 발행으로 진행");
    } catch (e) {
      console.error("[featured] 오류(일반 발행으로 진행):", e);
    }
  }

  // (감성 테마(Pexels/Pixabay 스톡)·여행지·명소 소개 게시물은 모두 제거됨.
  //  순수 맛집 전문 계정 — 2026-07 사용자 결정)

  // 카카오 발굴 회차: 확률적으로 카카오맵으로 "지역+메뉴" 맛집을 발굴(TourAPI 사진 연결).
  // TourAPI 자체 후보와 다른 맛집을 섞어 다양성을 높임. 키 없거나 실패 시 일반 발행.
  if (process.env.KAKAO_REST_KEY && Math.random() < 1 / 3) {
    try {
      const ks = await pickKakaoSpot();
      if (ks) {
        const dup = await db.execute({ sql: "SELECT 1 FROM posts WHERE content_id = ?", args: [ks.contentId] });
        if (dup.rows.length === 0) {
          const ksInfo = await fetchFoodInfo(ks.contentId);
          const cap = await generateCaption(ks, { menu: ksInfo.menu, hours: ksInfo.hours });
          if (!cap) return { skipped: true, reason: "AI 한도 소진 — 이번 회차 발행 건너뜀" };
          return await publishAndSave(ks, cap.caption, null);
        }
      }
    } catch (e) {
      console.error("[kakao] 발굴 오류(일반 발행으로 진행):", e);
    }
  }

  // 아직 안 올린 맛집 찾기 (최대 3번 시도).
  // 회차마다 후보 소스를 반반 랜덤: 유명 음식 키워드 발굴(searchKeyword2)로 그 음식의
  // 이름난 집을 정조준하거나, 지역 기반(areaBasedList2)으로 폭넓게 발굴.
  for (let attempt = 0; attempt < 3; attempt++) {
    // 두 소스 모두 이미 품질순(사진 여러 장 우선, 등급 내 셔플)으로 정렬해 반환하므로
    // 여기서 다시 셔플하지 않고 순서대로 사용한다.
    // 키워드 발굴은 반응 좋은 음식에 가중치를 줘 성과가 좋은 종류를 더 자주 발굴.
    const candidates =
      Math.random() < 0.5
        ? await fetchByFoodKeyword(await pickPerformingKeyword())
        : await fetchCandidates();
    for (const spot of candidates) {
      const dup = await db.execute({
        sql: "SELECT 1 FROM posts WHERE content_id = ?",
        args: [spot.contentId],
      });
      if (dup.rows.length > 0) continue;

      // 캐러셀용 이미지 수집 — 최소 장수 미달이면 이 후보는 건너뜀
      spot.imageUrls = await fetchQuizImages(spot.contentId, spot.imageUrl, spot.category);
      if (spot.imageUrls.length < MIN_IMAGES) continue;

      spot.overview = await fetchOverview(spot.contentId);
      const info = await fetchFoodInfo(spot.contentId);
      const cap = await generateCaption(spot, { menu: info.menu, hours: info.hours });
      if (!cap) return { skipped: true, reason: "AI 한도 소진 — 이번 회차 발행 건너뜀" };
      return await publishAndSave(spot, cap.caption, null);
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
  // 카카오맵 길찾기 링크. 기본은 키·승인 없이 만드는 검색 링크,
  // 로컬 API 키가 있으면 정확한 장소 페이지(place_url)로 업그레이드.
  const region = String(spot.address ?? "").split(/\s+/).slice(0, 2).join(" ");
  let mapUrl: string = (spot as any).mapUrl ?? searchMapUrl(spot.name, region);
  if (!(spot as any).mapUrl && process.env.KAKAO_REST_KEY) {
    try {
      const kp = await findPlace(spot.name, region);
      if (kp) mapUrl = mapLink(kp);
    } catch { /* 검색 링크 유지 */ }
  }

  // Meta 토큰이 아직 없으면 드라이런: 캡션·이미지만 저장하고 실제 업로드는 건너뜀.
  const dryRun = !process.env.IG_ACCESS_TOKEN || !process.env.IG_USER_ID;
  // 인스타에는 4:5 스마트 크롭 + 은은한 보정본을 올리고, DB(image_urls)에는 원본을 유지.
  // 표지(첫 사진)엔 스크롤 정지·저장을 유도하는 훅 텍스트를 얹는다.
  const hook = COVER_HOOKS[Math.floor(Math.random() * COVER_HOOKS.length)];
  const publishUrls = dryRun ? spot.imageUrls : await standardizePhotos(spot.imageUrls, { hook });
  const mediaId = dryRun ? null : await publishCarousel(publishUrls, caption);

  // 새 게시물을 스토리로도 공유 (계정 활동감 유지 — 실패해도 발행에는 영향 없음)
  // STORY_SHARE=0 으로 끌 수 있음
  if (!dryRun && process.env.STORY_SHARE !== "0") {
    try {
      await publishStory(spot.imageUrl);
    } catch (e) {
      console.error("[story] 공유 실패(무시):", String(e).slice(0, 150));
    }
  }

  await db.execute({
    sql: `INSERT INTO posts (content_id, place_name, address, category, image_url, image_urls, caption, ig_media_id, status, mapx, mapy, featured_by, map_url)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      mapUrl,
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
