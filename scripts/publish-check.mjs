// 발행 누락 감지 — "그날 나갔어야 할 게 나갔는가"를 날짜 단위로 확인한다.
//   npx tsx --env-file=.env scripts/publish-check.mjs
//
// 왜 필요한가: 발행이 빠지는 경로가 둘 다 조용하다.
//  (1) 하드 실패 — 2026-09-06(일) 저녁 TourAPI가 전부 `fetch failed`라 수집 풀이 0곳이 되어
//      모음집 슬롯이 5번 연속 실패했다. 그날 발행이 통째로 비었는데 아무도 몰랐다.
//  (2) 조용한 스킵 — "음식 사진 0곳", "AI 한도 소진"은 exit 0이라 Actions가 초록이다.
// 개별 런은 창 밖 게이트로 정상 스킵되는 게 많아 런 단위로는 신호가 안 된다.
//
// 출력: 누락된 KST 날짜마다 `missing-<날짜>.md`(이슈 본문)를 쓴다. 파일명이 곧 이슈 제목의
// 키다 — 제목을 '실행일'로 잡으면 같은 누락에 이슈가 두 번 열리고, 반대로 다음 날의 진짜
// 누락이 같은 제목에 막혀 조용히 삼켜진다(검토에서 시뮬레이션으로 확인).
// 종료 코드로 누락을 알리지 않는다 — 워크플로가 빨개지면 진짜 고장과 구분이 안 된다.
import fs from "node:fs";
import path from "node:path";

const OUT_DIR = process.env.OUT_DIR || ".";

// 하루에 나갔어야 할 것. CLAUDE.md '현재 발행 구성'과 같이 유지할 것.
// dow: 0=일 … 6=토. prefix는 posts.content_id 접두사.
const EXPECTED = [
  // 일반 릴스는 2026-09-15부터 화·목·토만 (69건 중앙값 134·시청 2.3s·히트 0 — 주 7 → 3회)
  { key: "reel", prefix: "reel-", label: "일반 릴스", dows: [], workflow: "reels.yml" }, // 2026-10-22 예약 발행 중단(수동만)
  { key: "roundup", prefix: "roundup-", label: "모음집", dows: [0, 1, 2, 3, 4, 5, 6], workflow: "roundup.yml" },
  { key: "countdown", prefix: "countdown-", label: "큐레이션", dows: [1, 3, 5, 6], workflow: "countdown.yml" }, // 2026-10-22 수·토 캐러셀 슬롯 흡수
  { key: "carousel", prefix: "carousel-", label: "캐러셀", dows: [], workflow: "carousel.yml" }, // 2026-10-22 예약 발행 중단(수동만)
];

// 마지막 발행 창(모음집 17:30~22:00 KST)이 닫힌 뒤에야 그날을 판정한다.
const DAY_CLOSED_KST_HOUR = 22;
const LOOKBACK_DAYS = 3; // 크론이 밀려 슬롯이 드롭돼도 놓친 날을 뒤늦게 잡도록

// 성공·스킵이 아닌 종료는 전부 '실패한 런'으로 본다. failure만 세면 타임아웃(cancelled로
// 기록됨)을 놓치는데, 9/6 사건에도 15분 타임아웃으로 cancelled된 런이 섞여 있었다.
const BAD_CONCLUSIONS = new Set(["failure", "timed_out", "cancelled", "startup_failure", "action_required"]);

const kstNow = () => new Date(Date.now() + 9 * 3600 * 1000);
const ymd = (d) => d.toISOString().slice(0, 10);

/**
 * 그날 정상 종료하지 못한 Actions 런 — 이슈에 붙여 원인 추적을 바로 시작할 수 있게.
 * 조회 자체가 막힌 경우(권한 없음 등)와 "실패한 런이 없음"을 반드시 구분한다. 뭉뚱그리면
 * 하드 실패를 '조용한 스킵'으로 오진한다 — actions:read 권한이 없던 초안이 그랬다.
 * @returns {Promise<string[]|null>} 런 목록, 조회 불가면 null
 */
async function failedRuns(workflow, dateKst) {
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  if (!repo || !token) return null;
  try {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/actions/workflows/${workflow}/runs?per_page=60`,
      { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(20000) }
    );
    if (!res.ok) {
      console.error(`  런 조회 실패 ${workflow}: HTTP ${res.status} (permissions에 actions:read 있는지 확인)`);
      return null;
    }
    const j = await res.json();
    return (j?.workflow_runs ?? [])
      .filter((r) => ymd(new Date(new Date(r.created_at).getTime() + 9 * 3600 * 1000)) === dateKst)
      .filter((r) => BAD_CONCLUSIONS.has(r.conclusion))
      .map((r) => `[${r.id} — ${r.conclusion}](${r.html_url})`);
  } catch (e) {
    console.error(`  런 조회 오류 ${workflow}: ${String(e).slice(0, 80)}`);
    return null;
  }
}

async function main() {
  // Turso가 없으면 lib/db.ts가 조용히 file:local.db로 폴백한다 — 러너에는 그 파일이 없으니
  // 빈 DB를 읽고 "전부 누락"이라고 이슈를 연다. 오탐 한 번이면 이 알림은 못 믿게 된다.
  if (!process.env.TURSO_DATABASE_URL) {
    throw new Error("TURSO_DATABASE_URL 없음 — 로컬 빈 DB로 폴백하면 전부 누락으로 오판하므로 중단");
  }
  const { db, initDb } = await import("../lib/db.ts");
  await initDb();

  const now = kstNow();
  const todayKst = ymd(now);
  const days = [];
  for (let i = 0; i < LOOKBACK_DAYS; i++) {
    const d = new Date(now.getTime() - i * 86400000);
    const day = ymd(d);
    // 오늘은 발행 창이 닫힌 뒤에만 판정 (그 전엔 아직 나갈 기회가 남아 있다)
    if (day === todayKst && now.getUTCHours() < DAY_CLOSED_KST_HOUR) continue;
    days.push({ day, dow: d.getUTCDay() });
  }

  // 최근 발행분을 한 번에 읽고 날짜별로 나눈다. created_at은 UTC 저장이라 +9시간이 KST 날짜.
  const rows = (
    await db.execute({
      sql: `SELECT content_id, date(created_at, '+9 hours') AS kst_day
              FROM posts
             WHERE status = 'published'
               AND date(created_at, '+9 hours') >= date('now', '+9 hours', ?)`,
      args: [`-${LOOKBACK_DAYS} days`],
    })
  ).rows;

  let wrote = 0;
  for (const { day, dow } of days) {
    const got = rows.filter((r) => String(r.kst_day) === day).map((r) => String(r.content_id));
    const due = EXPECTED.filter((e) => e.dows.includes(dow));
    const missing = due.filter((e) => !got.some((cid) => cid.startsWith(e.prefix)));
    console.log(
      `${day}(${"일월화수목금토"[dow]}) 예정 ${due.map((e) => e.label).join("·")} / ` +
        `발행 ${got.length}건${missing.length ? ` / ❌ 누락 ${missing.map((e) => e.label).join("·")}` : " / ✅"}`
    );
    if (!missing.length) continue;

    const lines = [`**${day} (${"일월화수목금토"[dow]})** 에 나갔어야 할 것이 빠졌습니다.`, ""];
    for (const m of missing) {
      const runs = await failedRuns(m.workflow, day);
      lines.push(`- **${m.label}** (\`${m.prefix}*\`) 발행 없음 — \`${m.workflow}\``);
      if (runs === null) {
        lines.push(`  - 그날 런 조회 불가 (권한·네트워크) — Actions에서 직접 확인하세요`);
      } else if (runs.length) {
        lines.push(`  - 정상 종료하지 못한 런: ${runs.join(", ")}`);
      } else {
        lines.push(`  - 실패한 런 없음 → 조용한 스킵(사진 부족·AI 한도·쿨다운·창 밖)일 수 있음`);
      }
    }
    if (got.length) lines.push("", `그날 나간 것: ${got.join(", ")}`);
    lines.push(
      "",
      "---",
      "확인 후 닫아 주세요. 같은 날짜로는 다시 열리지 않습니다.",
      "",
      "판정 기준: `posts`에 그 KST 날짜로 `status='published'` 행이 있는지. 발행 창이 닫힌(KST 22시) 날만 봅니다.",
      "요일 기대치: 모음집 매일 / 일반 릴스 화·목·토 / 큐레이션 월·금 / 캐러셀 수·토 (CLAUDE.md '현재 발행 구성')"
    );
    fs.writeFileSync(path.join(OUT_DIR, `missing-${day}.md`), lines.join("\n"));
    wrote++;
  }

  console.log(wrote ? `\n누락 ${wrote}일치 — missing-<날짜>.md 작성` : "\n누락 없음");
}

main().catch((e) => {
  console.error("발행 점검 실패:", String(e && e.stack ? e.stack : e).replace(/access_token=[^&\s"']+/g, "access_token=***"));
  process.exit(1);
});
