// 발행 누락 감지 — "오늘 나갔어야 할 게 나갔는가"를 하루 단위로 확인한다.
//   npx tsx --env-file=.env scripts/publish-check.mjs
//
// 왜 필요한가: 발행이 빠지는 경로가 두 가지인데 둘 다 조용하다.
//  (1) 하드 실패 — 2026-09-06 일요일 저녁, TourAPI가 전부 `fetch failed`라 수집 풀이 0곳이
//      되어 5개 슬롯이 연속 실패했다. 그날 모음집은 통째로 안 나갔는데 아무도 몰랐다.
//  (2) 조용한 스킵 — "음식 사진 확보 0곳", "AI 한도 소진"은 exit 0이라 Actions가 초록이다.
// 개별 런은 창 밖 게이트로 정상 스킵되는 게 많아서, 런 단위가 아니라 **날짜 단위**로
// "그날 발행물이 DB에 있는가"를 봐야 신호가 된다.
//
// 출력: 누락이 있으면 이슈 본문(마크다운)을 MISSING_FILE에 쓰고 종료. 없으면 파일을 안 만든다.
// (종료 코드로 알리지 않는 이유 — 워크플로가 실패로 보이면 진짜 실패와 구분이 안 된다)
import fs from "node:fs";

const MISSING_FILE = process.env.MISSING_FILE || "missing.md";

// 하루에 나갔어야 할 것. CLAUDE.md '현재 발행 구성'과 같이 유지할 것.
// dow: 0=일 … 6=토. prefix는 posts.content_id 접두사.
const EXPECTED = [
  { key: "reel", prefix: "reel-", label: "일반 릴스", dows: [0, 1, 2, 3, 4, 5, 6], workflow: "reels.yml" },
  { key: "roundup", prefix: "roundup-", label: "모음집", dows: [0, 1, 2, 3, 4, 5, 6], workflow: "roundup.yml" },
  { key: "countdown", prefix: "countdown-", label: "큐레이션", dows: [1, 5], workflow: "countdown.yml" },
  { key: "carousel", prefix: "carousel-", label: "캐러셀", dows: [6], workflow: "carousel.yml" },
];

// 마지막 발행 창(모음집 17:30~22:00 KST)이 닫힌 뒤에야 그날을 판정한다.
const DAY_CLOSED_KST_HOUR = 22;
const LOOKBACK_DAYS = 3; // 크론이 몇 시간 밀려도 놓친 날을 뒤늦게 잡도록

const kstNow = () => new Date(Date.now() + 9 * 3600 * 1000);
const ymd = (d) => d.toISOString().slice(0, 10);

/** 그날 실패한 Actions 런 — 이슈에 붙여 원인 추적을 바로 시작할 수 있게 (실패해도 무시) */
async function failedRuns(workflow, dateKst) {
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  if (!repo || !token) return [];
  try {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/actions/workflows/${workflow}/runs?per_page=50`,
      { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(20000) }
    );
    const j = await res.json();
    return (j?.workflow_runs ?? [])
      .filter((r) => ymd(new Date(new Date(r.created_at).getTime() + 9 * 3600 * 1000)) === dateKst)
      .filter((r) => r.conclusion === "failure")
      .map((r) => `[${r.id}](${r.html_url})`);
  } catch {
    return [];
  }
}

async function main() {
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
  if (!days.length) {
    console.log(`아직 발행 창이 닫히지 않았습니다 (KST ${String(now.getUTCHours()).padStart(2, "0")}시) — 판정 보류`);
    return;
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

  const sections = [];
  for (const { day, dow } of days) {
    const got = rows.filter((r) => String(r.kst_day) === day).map((r) => String(r.content_id));
    const due = EXPECTED.filter((e) => e.dows.includes(dow));
    const missing = due.filter((e) => !got.some((cid) => cid.startsWith(e.prefix)));
    console.log(
      `${day}(${"일월화수목금토"[dow]}) 예정 ${due.map((e) => e.label).join("·")} / ` +
        `발행 ${got.length}건${missing.length ? ` / ❌ 누락 ${missing.map((e) => e.label).join("·")}` : " / ✅"}`
    );
    if (!missing.length) continue;

    const lines = [`### ${day} (${"일월화수목금토"[dow]})`, ""];
    for (const m of missing) {
      const runs = await failedRuns(m.workflow, day);
      lines.push(
        `- **${m.label}** (\`${m.prefix}*\`) 발행 없음 — \`${m.workflow}\`` +
          (runs.length ? `\n  - 그날 실패한 런: ${runs.join(", ")}` : `\n  - 실패한 런 없음 → 조용한 스킵(사진 부족·AI 한도·창 밖)일 수 있음`)
      );
    }
    if (got.length) lines.push("", `그날 나간 것: ${got.join(", ")}`);
    sections.push(lines.join("\n"));
  }

  if (!sections.length) {
    console.log("누락 없음");
    return;
  }

  const body = [
    "최근 발행분에 빠진 회차가 있습니다. 각 항목의 실패 런 로그부터 확인하세요.",
    "",
    ...sections,
    "",
    "---",
    "확인 후 이 이슈는 닫아 주세요. 같은 날짜로는 다시 열리지 않습니다.",
    "",
    "판정 기준: `posts`에 그 KST 날짜로 `status='published'` 행이 있는지. 발행 창이 닫힌(KST 22시) 날만 봅니다.",
  ].join("\n");
  fs.writeFileSync(MISSING_FILE, body);
  console.log(`\n누락 ${sections.length}일치 — ${MISSING_FILE} 작성`);
}

main().catch((e) => {
  console.error("발행 점검 실패:", String(e && e.stack ? e.stack : e).replace(/access_token=[^&\s"']+/g, "access_token=***"));
  process.exit(1);
});
