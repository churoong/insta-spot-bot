import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 30;

/**
 * 발행 워크플로 정시 트리거 — vercel.json의 Vercel Cron이 호출한다.
 *
 * 왜 필요한가: GitHub Actions schedule은 혼잡기에 4~11.5시간 지연 + 슬롯 드롭까지
 * 발생한다(2026-08-27~09-01 실측 — 모음집이 심야 발행됨). Vercel Cron은 ±59분
 * 정확도로 도착하고, workflow_dispatch 런은 스케줄 큐를 거치지 않고 즉시 시작된다.
 * GitHub 쪽 schedule 크론은 이 트리거가 실패할 때의 폴백으로 남겨둔다.
 * 중복 발행은 각 스크립트의 하루 1회(KST) 가드가 막는다.
 *
 * GET /api/cron/trigger/{roundup|reels|countdown|carousel|story}
 *   (Authorization: Bearer $CRON_SECRET — Vercel Cron이 자동으로 붙여줌)
 * 필요 환경변수: GITHUB_TOKEN(Actions 쓰기 권한 PAT), GITHUB_REPO("owner/repo")
 */
const WORKFLOWS: Record<string, string> = {
  roundup: "roundup.yml",
  reels: "reels.yml",
  countdown: "countdown.yml",
  carousel: "carousel.yml",
  story: "story.yml",
};

export async function GET(req: NextRequest, ctx: { params: Promise<{ wf: string }> }) {
  const auth = req.headers.get("authorization");
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { wf } = await ctx.params;
  const file = WORKFLOWS[wf];
  if (!file) {
    return NextResponse.json({ error: `알 수 없는 워크플로: ${wf}` }, { status: 400 });
  }

  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO;
  if (!token || !repo) {
    // 트리거 비활성 — GitHub schedule 크론이 (지연을 감수하고) 발행을 담당
    return NextResponse.json({ skipped: true, reason: "GITHUB_TOKEN/GITHUB_REPO 미설정" });
  }

  try {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/actions/workflows/${file}/dispatches`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ref: "main" }),
        signal: AbortSignal.timeout(20000),
      }
    );
    if (res.status !== 204) {
      const body = await res.text();
      return NextResponse.json(
        {
          error: `workflow_dispatch 실패 HTTP ${res.status}: ${body.slice(0, 200)}`,
          필요권한: res.headers.get("x-accepted-github-permissions"),
        },
        { status: 500 }
      );
    }
    return NextResponse.json({ triggered: true, workflow: file });
  } catch (e) {
    return NextResponse.json({ error: String(e).slice(0, 300) }, { status: 500 });
  }
}
