// 모음집 표지 3안(classic/hero/dark) 성과 비교.
//   npx tsx --env-file=.env scripts/cover-report.mjs
//
// 왜 조회수인가: 이 계정에서 좋아요는 배포 성과와 무관하다(2026-08-18 짬뽕 모음집은
// 좋아요 3개인데 조회 2,236·도달 1,444로 유일하게 팔로워 밖까지 나갔다).
// 표지 디자인이 노리는 건 "스크롤을 멈추게 하는 것"이므로 조회·도달·저장으로 본다.
//
// ⚠️ 발행 후 경과 시간이 다르면 오래된 게시물이 유리하다. 그래서 스타일별 평균과 함께
//    회차별 원자료를 그대로 출력한다 — 숫자 하나만 보고 결론 내지 말 것.

const B = "https://graph.instagram.com/v23.0";
// 토큰은 DB의 최신 값(config.ig_token)이 우선 — env IG_ACCESS_TOKEN은 최초 시드용이라
// 60일 지나면 만료돼 있을 수 있다(lib/instagram.ts getToken과 같은 규칙).
let TOKEN = process.env.IG_ACCESS_TOKEN;
// 토큰이 URL 쿼리에 들어가므로 예외 메시지에 그대로 실릴 수 있다 — 로그에 남기기 전에 가린다
const safe = (e) => String(e && e.stack ? e.stack : e).replace(/access_token=[^&\s"']+/g, "access_token=***");

const STYLES = ["classic", "hero", "pages", "dark"];
const LABEL = { classic: "기존(흰 카드)", hero: "A안(히어로)", pages: "페이지형(슬라이드)", dark: "C안(다크)" };

async function insights(mediaId) {
  try {
    const r = await fetch(
      `${B}/${mediaId}/insights?metric=views,reach,saved,shares,ig_reels_avg_watch_time&access_token=${TOKEN}`,
      { signal: AbortSignal.timeout(15000) }
    );
    const j = await r.json();
    if (!Array.isArray(j?.data)) return null;
    const o = {};
    for (const d of j.data) o[d.name] = d.values?.[0]?.value ?? 0;
    return o;
  } catch {
    return null;
  }
}

async function main() {
  const { db, initDb } = await import("../lib/db.ts");
  await initDb();
  try {
    const t = await db.execute("SELECT value FROM config WHERE key = 'ig_token'");
    if (t.rows[0]?.value) TOKEN = String(t.rows[0].value);
  } catch { /* config 없음 — env 토큰으로 */ }
  if (!TOKEN) console.log("⚠️ IG 토큰 없음 — 크론이 저장한 DB 지표만 사용합니다(공유·시청 시간 제외).");

  const rows = (
    await db.execute(
      `SELECT content_id, cover_style, title_font, ig_media_id, created_at, views, reach, saved, metrics_at
         FROM posts
        WHERE category = '모음집' AND status = 'published'
          AND ig_media_id IS NOT NULL AND cover_style IS NOT NULL
        ORDER BY id ASC`
    )
  ).rows;

  if (!rows.length) {
    console.log("아직 표지 스타일이 기록된 모음집이 없습니다. (3안 순환 발행 이후부터 쌓입니다)");
    return;
  }

  const stat = Object.fromEntries(STYLES.map((s) => [s, []]));
  const fontStat = {}; // 서체 A/B (title_font 기록이 있는 회차만)
  let fromApi = 0, fromDb = 0, noData = 0;
  console.log("── 회차별 ──");
  for (const r of rows) {
    // 라이브 인사이트가 1순위. 토큰 만료·한도로 막히면 /api/cron/metrics(하루 2회)가
    // posts에 저장해 둔 조회·도달·저장으로 대신한다 — 공유·시청 시간은 그때 못 본다.
    let ins = await insights(String(r.ig_media_id));
    if (ins) fromApi++;
    else if (r.views != null) {
      ins = { views: Number(r.views), reach: Number(r.reach ?? 0), saved: Number(r.saved ?? 0) };
      fromDb++;
    } else noData++;
    const style = String(r.cover_style);
    if (ins && stat[style]) stat[style].push(ins);
    const font = r.title_font ? String(r.title_font) : null;
    if (ins && font && font !== "manual") (fontStat[font] ??= []).push(ins);
    const day = String(r.created_at ?? "").slice(0, 10);
    console.log(
      `${day} | ${(LABEL[style] ?? style).padEnd(13)} | 조회 ${String(ins?.views ?? "-").padStart(6)}` +
        ` | 도달 ${String(ins?.reach ?? "-").padStart(5)} | 저장 ${String(ins?.saved ?? "-").padStart(3)}` +
        ` | 공유 ${String(ins?.shares ?? "-").padStart(3)}` +
        ` | 시청 ${ins?.ig_reels_avg_watch_time ? (ins.ig_reels_avg_watch_time / 1000).toFixed(1) + "s" : "-"}` +
        (font ? ` | ${font}` : "") +
        ` | ${r.content_id}`
    );
  }
  console.log(`(지표 출처: 라이브 ${fromApi}건 / DB 저장분 ${fromDb}건 / 없음 ${noData}건)`);

  const avg = (a, k) => (a.length ? a.reduce((s, x) => s + (x[k] ?? 0), 0) / a.length : 0);
  console.log("\n── 스타일별 평균 ──");
  for (const s of STYLES) {
    const a = stat[s];
    if (!a.length) {
      console.log(`${LABEL[s].padEnd(13)} | 표본 없음`);
      continue;
    }
    console.log(
      `${LABEL[s].padEnd(13)} | 표본 ${String(a.length).padStart(2)}건` +
        ` | 조회 ${Math.round(avg(a, "views")).toString().padStart(6)}` +
        ` | 도달 ${Math.round(avg(a, "reach")).toString().padStart(5)}` +
        ` | 저장 ${avg(a, "saved").toFixed(1).padStart(4)}` +
        ` | 공유 ${avg(a, "shares").toFixed(1).padStart(4)}` +
        ` | 시청 ${(avg(a, "ig_reels_avg_watch_time") / 1000).toFixed(1)}s`
    );
  }

  const n = Math.min(...STYLES.filter((s) => stat[s].length > 0).map((s) => stat[s].length)); // 순환에서 빠진 스타일(dark)은 제외
  if (n < 5) {
    console.log(
      `\n⚠️ 가장 적은 스타일의 표본이 ${n}건입니다. 조회수 편차가 커서 스타일당 5건은 모여야 판단할 수 있습니다.`
    );
  }

  // 서체 A/B (2026-09-02~): G마켓 산스 vs 잘난체 — 그리드 모음집 교대 발행분만 집계
  const fonts = Object.keys(fontStat);
  if (fonts.length) {
    console.log("\n── 서체별 평균 (A/B) ──");
    for (const f of fonts) {
      const a = fontStat[f];
      console.log(
        `${f.padEnd(8)} | 표본 ${String(a.length).padStart(2)}건` +
          ` | 조회 ${Math.round(avg(a, "views")).toString().padStart(6)}` +
          ` | 도달 ${Math.round(avg(a, "reach")).toString().padStart(5)}` +
          ` | 저장 ${avg(a, "saved").toFixed(1).padStart(4)}` +
          ` | 공유 ${avg(a, "shares").toFixed(1).padStart(4)}` +
          ` | 시청 ${(avg(a, "ig_reels_avg_watch_time") / 1000).toFixed(1)}s`
      );
    }
    const fn = Math.min(...fonts.map((f) => fontStat[f].length));
    if (fonts.length < 2 || fn < 5) {
      console.log("⚠️ 서체당 5건은 모여야 판단 가능 (교대 발행이라 열흘쯤 걸립니다).");
    }
  }
}

main().catch((e) => {
  console.error("표지 성과 분석 실패:", safe(e));
  process.exit(1);
});
