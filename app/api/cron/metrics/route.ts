import { NextRequest, NextResponse } from "next/server";
import { db, initDb } from "@/lib/db";
import { fetchInsights } from "@/lib/instagram";
import { refreshThreadsToken } from "@/lib/threads";

export const maxDuration = 60;

/**
 * 게시물 인사이트(조회·도달·저장) 갱신 — Vercel Cron이 하루 2회 호출(07:00·19:00 KST).
 * 관리 페이지(/)가 이 값을 보여준다. 좋아요는 /api/cron/post 가 따로 갱신.
 *
 * GET /api/cron/metrics?days=60  (Authorization: Bearer $CRON_SECRET)
 *  - 최근 N일(기본 60) 발행분 + 한 번도 안 받은 게시물을 최신순 최대 80건 갱신
 *  - 인스타 인사이트는 발행 후 며칠간 계속 오르므로 최근 것 위주로 반복 갱신
 */
export async function GET(req: NextRequest) {
  if (process.env.CRON_SECRET && req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const days = Math.min(365, Math.max(1, Number(req.nextUrl.searchParams.get("days") ?? 60)));
  await initDb();

  const rows = (
    await db.execute({
      sql: `SELECT id, ig_media_id FROM posts
             WHERE status = 'published' AND ig_media_id IS NOT NULL
               AND (metrics_at IS NULL OR created_at >= datetime('now', ?))
             ORDER BY (metrics_at IS NULL) DESC, id DESC LIMIT 80`, // 미집계분 우선
      args: [`-${days} days`],
    })
  ).rows as any[];

  let ok = 0, fail = 0;
  // 인스타 API 호출은 4개씩 병렬 (레이트리밋·함수 시간 60초 안)
  for (let i = 0; i < rows.length; i += 4) {
    await Promise.all(
      rows.slice(i, i + 4).map(async (r) => {
        const ins = await fetchInsights(String(r.ig_media_id));
        if (!ins) { fail++; return; }
        await db.execute({
          sql: "UPDATE posts SET views = ?, reach = ?, saved = ?, metrics_at = datetime('now') WHERE id = ?",
          args: [ins.views, ins.reach, ins.saved, r.id],
        });
        ok++;
      })
    );
  }
  // 스레드 장기 토큰(60일) 유지 — 모음집이 멈춰도 여기서 7일마다 갱신된다
  const threads = await refreshThreadsToken().catch((e) => String(e).slice(0, 120));
  return NextResponse.json({ checked: rows.length, updated: ok, failed: fail, threads });
}
