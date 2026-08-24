import { NextRequest, NextResponse } from "next/server";
import { db, initDb } from "@/lib/db";
import { fetchCandidates, fetchByFoodKeyword, fetchOverview, fetchFoodInfo, fetchQuizImages } from "@/lib/tourapi";
import { generateCaption, generateNarration, generateHook } from "@/lib/caption";
import { pickPerformingKeyword } from "@/lib/performance";
import { searchMapUrl } from "@/lib/kakao";
import { blogBuzz, buzzQuery } from "@/lib/naver";
import { fetchSeoulCandidates, seoulAvailable } from "@/lib/seoulfood";
import { pickFoodImages } from "@/lib/vision";
import { markGoodPrice } from "@/lib/goodprice";

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

  // 번들 파일 추적 검증용 진단 (배포 후 ?diag=1 — 데이터 파일이 실제로 번들에 있는지)
  if (req.nextUrl.searchParams.get("diag") === "1") {
    const { fetchSeoulCandidates } = await import("@/lib/seoulfood");
    const seoulPool = (await fetchSeoulCandidates(9999)).length;
    const gpProbe: any = { name: "돈까스보라", address: "서울특별시 종로구 대학로5길 5" };
    markGoodPrice([gpProbe]);
    return NextResponse.json({ seoulPool, goodpriceOk: Boolean(gpProbe.goodPrice) });
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
        // 소스 다변화(2026-08): 서울 음식관광 DB(자체 사진 보유)가 준비돼 있으면
        // 1/4 확률로 섞는다. 나머지는 기존 TourAPI 두 경로.
        const r = Math.random();
        cands =
          seoulAvailable() && r < 0.25
            ? await fetchSeoulCandidates()
            : r < 0.625
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

          // 인기도 게이트 — 블로그 후기가 거의 없는 무명 가게는 콘텐츠 가치가 낮다.
          // (실측: 유명 노포 16,000건 vs 무명집 4건). 시도를 거듭할수록 기준을 낮춰
          // 후보가 아예 없어 발행이 멈추는 일은 없게 한다.
          const minBuzz = [300, 100, 30, 0, 0][attempt] ?? 0;
          if (minBuzz > 0) {
            const buzz = await blogBuzz(buzzQuery(s.name, s.address));
            if (buzz !== null && buzz < minBuzz) continue;
            (s as any).buzz = buzz ?? 0;
          }

          // 음식 사진이 없어도 발행 가능(디자인 카드로 대체)하지만, 사진이 있는 곳을
          // 우선하기 위해 앞쪽 후보에서는 사진 있는 곳만 고르고, 뒤로 갈수록 허용한다.
          // 서울 소스는 사진을 이미 갖고 있다 — TourAPI 이미지 조회 대신
          // 같은 비전 선별만 돌린다. 상세(overview·메뉴)도 TourAPI 전용이라 건너뜀.
          const isSeoul = s.contentId.startsWith("seoul-");
          const imgs = isSeoul
            ? await pickFoodImages(s.imageUrls)
            : await fetchQuizImages(s.contentId, s.imageUrl, s.category);
          if (imgs.length < 1 && attempt < 2) continue;

          if (!isSeoul) s.overview = await fetchOverview(s.contentId);
          const info = isSeoul ? { menu: "", hours: "" } : await fetchFoodInfo(s.contentId);
          // 착한가격업소면 캡션 첫 훅과 정보 블록에 반영 (가격은 TourAPI에 없는 팩트)
          markGoodPrice([s as any]);
          const gp = (s as any).goodPrice as { menu: string; price: number } | undefined;
          const cap = await generateCaption(s, {
            menu: info.menu,
            hours: info.hours,
            goodPrice: gp,
            featuredBy: gp
              ? `정부가 지정한 착한가격업소${gp.price ? `(${gp.menu} ${gp.price.toLocaleString()}원)` : ""}`
              : undefined,
          });
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
          // 컷 수 = 나레이션 문장 수. 평균 시청이 2초인데 영상이 길면 완주율이 바닥이라
          // 4문장(약 11~14초)으로 짧게 간다. 짧은 영상은 반복 재생도 걸린다.
          const narration = await generateNarration(s, { menu: info.menu, lines: 4 });
          // 첫 화면 텍스트 훅 카드 문구 (사진이 아니라 '문구'로 스크롤을 멈추게 함)
          const hook = await generateHook(s, { menu: info.menu, goodPrice: gp });

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
