import { NextRequest, NextResponse } from "next/server";
import { db, initDb } from "@/lib/db";

export const maxDuration = 60;

/**
 * 릴스 워크플로 트리거 — cron-job.org 등 외부 크론이 호출한다.
 *
 * 왜 필요한가: GitHub Actions의 schedule은 자주 누락된다(2026-08 실측: 하루 4회
 * 예약 중 1회만 실행). 릴스가 유일한 발행 수단이 된 뒤로는 이 누락이 곧 무발행이라,
 * 안정적으로 도는 외부 크론이 workflow_dispatch로 직접 실행시킨다.
 *
 * GET /api/cron/trigger-reel  (Authorization: Bearer $CRON_SECRET)
 *  - GITHUB_TOKEN(repo/actions 권한 PAT)과 GITHUB_REPO(예 "churoong/insta-spot-bot") 필요
 *  - MIN_GAP_MIN(기본 150분) 안에 이미 발행된 릴스가 있으면 건너뜀(과다 발행 방지)
 */
export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO;

  // ?check=1 → 환경변수 설정 상태만 확인 (값은 노출하지 않음)
  if (req.nextUrl.searchParams.get("check") === "1") {
    return NextResponse.json({
      GITHUB_TOKEN: Boolean(token),
      GITHUB_REPO: repo ?? null,
      GROQ_KEY: Boolean(process.env.GROQ_KEY),
      GEMINI_API_KEY: Boolean(process.env.GEMINI_API_KEY),
    });
  }

  if (!token || !repo) {
    return NextResponse.json(
      { skipped: true, reason: "GITHUB_TOKEN/GITHUB_REPO 미설정 — 트리거 비활성" },
      { status: 200 }
    );
  }
  const force = req.nextUrl.searchParams.get("force") === "1"; // 테스트용 즉시 실행

  try {
    await initDb();

    // 심야(KST 00~07)에는 발행하지 않음
    const kstHour = (new Date().getUTCHours() + 9) % 24;
    if (!force && process.env.QUIET_HOURS_OFF !== "1" && kstHour < 8) {
      return NextResponse.json({ skipped: true, reason: `KST 심야(${kstHour}시) — 트리거 안 함` });
    }

    // 최근 발행 간격 확인 (외부 크론이 자주 호출해도 과다 발행되지 않게)
    const gapMin = Number(process.env.MIN_GAP_MIN || 150);
    if (!force) {
      const recent = await db.execute({
        sql: `SELECT created_at FROM posts
              WHERE status IN ('published','publishing')
                AND created_at >= datetime('now', ?)
              ORDER BY id DESC LIMIT 1`,
        args: [`-${gapMin} minutes`],
      });
      if (recent.rows.length > 0) {
        return NextResponse.json({
          skipped: true,
          reason: `최근 ${gapMin}분 내 발행됨 — 트리거 안 함`,
        });
      }
    }

    // GitHub Actions 워크플로 실행
    const res = await fetch(
      `https://api.github.com/repos/${repo}/actions/workflows/reels.yml/dispatches`,
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
        { error: `workflow_dispatch 실패 HTTP ${res.status}: ${body.slice(0, 200)}` },
        { status: 500 }
      );
    }
    return NextResponse.json({ triggered: true, workflow: "reels.yml" });
  } catch (e) {
    return NextResponse.json({ error: String(e).slice(0, 300) }, { status: 500 });
  }
}
