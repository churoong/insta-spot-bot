import { NextRequest, NextResponse } from "next/server";
import { db, initDb } from "@/lib/db";
import { fetchCandidates, fetchByFoodKeyword, fetchOverview, fetchFoodInfo, fetchQuizImages } from "@/lib/tourapi";
import { generateCaption, generateNarration, generateHook } from "@/lib/caption";
import { pickPerformingKeyword } from "@/lib/performance";
import { searchMapUrl } from "@/lib/kakao";

// 캡션 생성 + 비전 사진 선별이 60초를 넘을 수 있음
export const maxDuration = 300;

/**
 * 릴스 후보 공급 API — GitHub Actions(릴스 렌더)가 호출한다.
 *
 * 왜 필요한가: data.go.kr(TourAPI)가 GitHub Actions 러너의 해외·클라우드 IP를
 * 간헐적으로 차단해 Actions에서 후보 수집이 통째로 실패했다(2026-08 실측).
 * Vercel에서는 정상 접근되므로, 데이터 수집·캡션 생성은 Vercel이 맡고
 * Actions는 영상 렌더·발행만 담당하도록 역할을 분리한다.
 *
 * 이미지 URL은 /api/image 프록시 경유로 돌려줘, Actions가 visitkorea에
 * 직접 접근하지 않아도 되게 한다(같은 차단 위험 회피).
 *
 * GET /api/reel-candidate  (Authorization: Bearer $CRON_SECRET)
 */
export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    await initDb();
    const origin = req.nextUrl.origin;
    const proxy = (u: string, i: number) =>
      `${origin}/api/image?url=${encodeURIComponent(u)}&name=r${i}`;

    // 아직 릴스로 안 만든 새 맛집 발굴 (음식 사진 1장 이상)
    let capFails = 0; // 캡션 생성 실패 횟수(규칙 위반·AI 한도 등)
    for (let attempt = 0; attempt < 5; attempt++) {
      let cands: Awaited<ReturnType<typeof fetchCandidates>> = [];
      try {
        cands =
          Math.random() < 0.5
            ? await fetchByFoodKeyword(await pickPerformingKeyword())
            : await fetchCandidates();
      } catch (e) {
        console.error(`[reel-candidate] 후보 수집 실패(시도 ${attempt + 1}):`, String(e).slice(0, 120));
        continue;
      }

      for (const s of cands) {
        try {
          const dup = await db.execute({
            sql: "SELECT 1 FROM posts WHERE content_id IN (?, ?)",
            args: [s.contentId, "reel-" + s.contentId],
          });
          if (dup.rows.length) continue;

          // 음식 사진이 없어도 발행 가능(디자인 카드로 대체)하지만, 사진이 있는 곳을
          // 우선하기 위해 앞쪽 후보에서는 사진 있는 곳만 고르고, 뒤로 갈수록 허용한다.
          const imgs = await fetchQuizImages(s.contentId, s.imageUrl, s.category);
          if (imgs.length < 1 && attempt < 2) continue;

          s.overview = await fetchOverview(s.contentId);
          const info = await fetchFoodInfo(s.contentId);
          const cap = await generateCaption(s, { menu: info.menu, hours: info.hours });
          if (!cap) {
            // 캡션 실패 원인은 다양(AI 한도·규칙 위반 등). 한 곳 실패로 포기하지 않고
            // 다음 후보를 시도하되, 연속 실패가 많으면 AI 문제로 보고 중단한다.
            capFails++;
            console.error(`[reel-candidate] 캡션 생성 실패(${capFails}) ${s.name}`);
            if (capFails >= 4) {
              return NextResponse.json({ skipped: true, reason: "캡션 생성 연속 실패(AI 한도 또는 규칙 위반)" });
            }
            continue;
          }

          // 릴스 나레이션 대본(자막·TTS용). 실패해도 무음 릴스로 진행하므로 치명적이지 않음.
          const narration = await generateNarration(s, {
            menu: info.menu,
            lines: Math.min(Math.max(imgs.length, 3), 5),
          });
          // 첫 화면 텍스트 훅 카드 문구 (사진이 아니라 '문구'로 스크롤을 멈추게 함)
          const hook = await generateHook(s, { menu: info.menu });

          const region = String(s.address ?? "").split(/\s+/).slice(0, 2).join(" ");
          return NextResponse.json({
            contentId: s.contentId,
            name: s.name,
            address: s.address,
            category: s.category,
            imageUrls: imgs.map(proxy), // Actions는 프록시로 받음
            originalUrls: imgs, // DB 기록용 원본
            caption: cap.caption,
            narration: narration ?? [],
            hook: hook ?? null,
            menu: info.menu || null, // 사진 없을 때 디자인 카드에 표시
            mapx: s.mapx ?? null,
            mapy: s.mapy ?? null,
            mapUrl: searchMapUrl(s.name, region),
          });
        } catch (e) {
          console.error(`[reel-candidate] 후보 처리 실패(건너뜀) ${s.name}:`, String(e).slice(0, 100));
        }
      }
    }
    return NextResponse.json({ skipped: true, reason: "발행할 새 맛집을 찾지 못함" });
  } catch (e) {
    return NextResponse.json({ error: String(e).slice(0, 300) }, { status: 500 });
  }
}
