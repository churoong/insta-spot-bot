// 조회수 추세 진단 — 왜 떨어졌는지(또는 안 떨어졌는지)를 원자료로 본다.
//   npx tsx --env-file=.env scripts/trend-report.mjs
//   (러너: trend.yml 실행 — 시크릿 없는 세션도 결과를 읽을 수 있다)
//
// cover-report.mjs와 무엇이 다른가: 저건 **모음집 중 cover_style이 있는 회차만** 본다.
// 큐레이션(cover_style NULL)·일반 릴스(category 다름)가 통째로 빠져서, "계정 전체 조회가
// 떨어졌다"는 질문에는 답할 수 없다. 여기서는 발행된 전 게시물을 한 줄씩 놓고 본다.
//
// ⚠️ 이 리포트가 가장 조심하는 것: **발행 후 경과 시간**.
//    어제 나간 게시물은 지난주 것보다 무조건 낮게 찍힌다. 그걸 "조회수 하락"으로 읽으면
//    없는 문제를 쫓게 된다. 그래서 (1) 경과 시간을 매 줄에 찍고 (2) 평균은 '충분히 익은'
//    표본(기본 72시간 이상)만으로 따로 낸다.
//
// 쓰기 없음 — SELECT만 한다(initDb의 스키마 보정은 예외).

const B = "https://graph.instagram.com/v23.0";
let TOKEN = process.env.IG_ACCESS_TOKEN;
const safe = (e) => String(e && e.stack ? e.stack : e).replace(/access_token=[^&\s"']+/g, "access_token=***");

// 이 시간이 지난 게시물만 평균에 넣는다. 인스타 릴스는 초반 며칠에 배포가 몰려서
// 그 전에는 회차 간 비교가 성립하지 않는다.
const MATURE_H = Number(process.env.TREND_MATURE_HOURS || 72);

const TYPES = [
  { key: "reel-", label: "일반 릴스" },
  { key: "roundup-", label: "모음집" },
  { key: "countdown-", label: "큐레이션" },
  { key: "carousel-", label: "캐러셀" },
];
const typeOf = (cid) => TYPES.find((t) => String(cid).startsWith(t.key))?.label ?? "기타";

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

// created_at은 UTC 'YYYY-MM-DD HH:MM:SS'(datetime('now')) — KST 표기로 바꿔 읽는다.
const kst = (s) => new Date(String(s).replace(" ", "T") + "Z");
const ymdKst = (d) => new Date(d.getTime() + 9 * 3600e3).toISOString().slice(0, 10);
const hmKst = (d) => new Date(d.getTime() + 9 * 3600e3).toISOString().slice(11, 16);
// ISO 주차 대신 '해당 주 월요일(KST)'로 묶는다 — 읽을 때 날짜가 바로 보인다.
const weekOf = (d) => {
  const k = new Date(d.getTime() + 9 * 3600e3);
  const dow = (k.getUTCDay() + 6) % 7; // 월=0
  k.setUTCDate(k.getUTCDate() - dow);
  return k.toISOString().slice(0, 10);
};

const avg = (a, k) => {
  const v = a.map((x) => x[k]).filter((x) => x != null);
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
};
const med = (a, k) => {
  const v = a.map((x) => x[k]).filter((x) => x != null).sort((p, q) => p - q);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};
const num = (x, w = 6, d = 0) => (x == null ? "-" : x.toFixed(d)).padStart(w);

async function main() {
  const { db, initDb } = await import("../lib/db.ts");
  await initDb();
  try {
    const t = await db.execute("SELECT value FROM config WHERE key = 'ig_token'");
    if (t.rows[0]?.value) TOKEN = String(t.rows[0].value);
  } catch { /* config 없음 — env 토큰으로 */ }
  if (!TOKEN) console.log("⚠️ IG 토큰 없음 — 크론이 저장한 DB 지표만 씁니다(공유·시청 시간 제외).\n");

  const cols =
    "content_id, place_name, category, created_at, ig_media_id, views, reach, saved, metrics_at, cover_style, title_font";
  let rows;
  try {
    rows = (await db.execute(
      `SELECT ${cols}, reel_format FROM posts
        WHERE status = 'published' AND ig_media_id IS NOT NULL
        ORDER BY created_at ASC`
    )).rows;
  } catch {
    rows = (await db.execute(
      `SELECT ${cols} FROM posts
        WHERE status = 'published' AND ig_media_id IS NOT NULL
        ORDER BY created_at ASC`
    )).rows;
  }
  if (!rows.length) return console.log("발행된 게시물이 없습니다.");

  const now = Date.now();
  const items = [];
  let fromApi = 0, fromDb = 0, noData = 0;
  console.log(`── 전 회차 (발행 순, KST) — 총 ${rows.length}건 ──`);
  for (const r of rows) {
    let ins = await insights(String(r.ig_media_id));
    if (ins) fromApi++;
    else if (r.views != null) {
      // 크론은 views/reach/saved만 저장한다 — 공유·시청은 키를 아예 넣지 않아
      // 평균에서 '0'이 아니라 '모름'으로 빠지게 한다.
      ins = { views: Number(r.views), reach: Number(r.reach ?? 0), saved: Number(r.saved ?? 0) };
      fromDb++;
    } else {
      noData++;
      ins = {};
    }
    const d = kst(r.created_at);
    const ageH = (now - d.getTime()) / 3600e3;
    const it = {
      day: ymdKst(d),
      hm: hmKst(d),
      week: weekOf(d),
      type: typeOf(r.content_id),
      ageH,
      mature: ageH >= MATURE_H,
      views: ins.views ?? null,
      reach: ins.reach ?? null,
      saved: ins.saved ?? null,
      shares: ins.shares ?? null,
      watch: ins.ig_reels_avg_watch_time != null ? ins.ig_reels_avg_watch_time / 1000 : null,
      cid: String(r.content_id),
      name: String(r.place_name ?? "").slice(0, 28),
    };
    items.push(it);
    console.log(
      `${it.day} ${it.hm} | ${it.type.padEnd(6)} | ${(ageH < 100 ? ageH.toFixed(0) + "h" : Math.round(ageH / 24) + "d").padStart(4)}` +
        ` | 조회 ${num(it.views)} | 도달 ${num(it.reach, 5)} | 저장 ${num(it.saved, 3)}` +
        ` | 공유 ${num(it.shares, 3)} | 시청 ${it.watch == null ? "    -" : (it.watch.toFixed(1) + "s").padStart(5)}` +
        ` | ${it.name}`
    );
  }
  console.log(`(지표 출처: 라이브 ${fromApi}건 / DB 저장분 ${fromDb}건 / 없음 ${noData}건)`);

  const mature = items.filter((x) => x.mature && x.views != null);
  console.log(
    `\n※ 아래 평균은 발행 후 ${MATURE_H}시간이 지난 ${mature.length}건만 씁니다 ` +
      `(막 나간 ${items.length - mature.length}건은 아직 배포 중이라 낮게 찍힙니다 — 그걸 하락으로 읽지 말 것).`
  );

  const table = (title, groups) => {
    console.log(`\n── ${title} ──`);
    for (const [k, a] of groups) {
      if (!a.length) continue;
      console.log(
        `${k.padEnd(12)} | ${String(a.length).padStart(2)}건` +
          ` | 조회 평균 ${num(avg(a, "views"))} 중앙 ${num(med(a, "views"))}` +
          ` | 도달 ${num(avg(a, "reach"), 5)} | 저장 ${num(avg(a, "saved"), 4, 1)}` +
          ` | 시청 ${avg(a, "watch") == null ? "    -" : (avg(a, "watch").toFixed(1) + "s").padStart(5)}`
      );
    }
  };

  // 주차별 — "급격히 떨어졌나"는 여기서 읽힌다. 평균은 대박 1건에 끌려가므로 중앙값을 같이 본다.
  const weeks = [...new Set(mature.map((x) => x.week))].sort();
  table(
    "주차별 (해당 주 월요일)",
    weeks.map((w) => [w, mature.filter((x) => x.week === w)])
  );

  // 종류별 — 릴스가 떨어진 건지 캐러셀이 떨어진 건지
  table(
    "종류별",
    [...new Set(mature.map((x) => x.type))].map((t) => [t, mature.filter((x) => x.type === t)])
  );

  // 종류 × 주차 — 종류마다 추세가 다르면 원인이 다르다
  console.log("\n── 종류 × 주차 (조회 중앙값) ──");
  const types = [...new Set(mature.map((x) => x.type))];
  console.log("주차".padEnd(12) + types.map((t) => t.padStart(9)).join(" "));
  for (const w of weeks) {
    console.log(
      w.padEnd(12) +
        types
          .map((t) => {
            const a = mature.filter((x) => x.week === w && x.type === t);
            return (a.length ? `${Math.round(med(a, "views"))}(${a.length})` : "-").padStart(9);
          })
          .join(" ")
    );
  }

  // 발행 밀도 — 하루 몇 건 내보내는지. 늘렸는데 총 조회가 그대로면 회차당 평균은 당연히 준다.
  console.log("\n── 발행 밀도 (주당 건수, 전 회차 기준) ──");
  for (const w of [...new Set(items.map((x) => x.week))].sort()) {
    const a = items.filter((x) => x.week === w);
    const byType = types.map((t) => `${t} ${a.filter((x) => x.type === t).length}`).join(" · ");
    const sum = a.filter((x) => x.views != null).reduce((s, x) => s + x.views, 0);
    console.log(`${w} | ${String(a.length).padStart(2)}건 | ${byType} | 주간 총 조회 ${String(sum).padStart(6)}`);
  }

  // 팔로워 — 도달이 팔로워 수에 눌린 건지 보려면 분모를 알아야 한다
  try {
    const f = await db.execute("SELECT date, count FROM follower_log ORDER BY date ASC");
    if (f.rows.length) {
      console.log("\n── 팔로워 추이 ──");
      const r = f.rows;
      const step = Math.max(1, Math.floor(r.length / 14));
      for (let i = 0; i < r.length; i += step) console.log(`${r[i].date} | ${r[i].count}`);
      if ((r.length - 1) % step) console.log(`${r.at(-1).date} | ${r.at(-1).count}`);
    }
  } catch { /* follower_log 없음 */ }
}

main().catch((e) => {
  console.error("리포트 실패:", safe(e));
  process.exit(1);
});
