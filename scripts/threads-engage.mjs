/**
 * 스레드 대화·투표·성과(2026-11-04 사용자 결정 — 스레드 아이디어 1·2·4·5). GitHub Actions에서 2시간마다.
 *  1) 답글 응대: 최근 3일 우리 글(질문·한 그릇·투표·동시 발행)에 달린 답글마다 짧은 긍정 답글 — 하루 20, 한 사람·한 글에 1번.
 *     스레드는 대화가 이어지는 글을 더 퍼뜨린다. LLM이 못 쓰거나 부정·광고·무관한 답글이면 답하지 않는다.
 *  2) 이웃 추천 모음: 동네 질문 글이 올라간 지 20~72시간이면 답글에서 가게 이름만 뽑아 원글 아래에 정리(2곳 이상일 때).
 *  3) 다음 편 투표: 매주 목요일 12시 이후 1회, 전국 음식 4개로 투표 글. 48시간 뒤 1위를 다음 전국 음식 슬롯
 *     (월·수·금·일)에 config next_roundup_theme으로 예약하고 결과를 투표 글 아래에 알린다.
 *  4) 성과: 최근 14일 스레드 글의 조회·좋아요·답글·리포스트·공유를 threads_posts에 모은다(관리 페이지 카드).
 * 실행: THREADS_ENGAGE_DRY=1 npx tsx --env-file=.env scripts/threads-engage.mjs (쓰기 없이 할 일만 출력)
 */
import { db, initDb } from "../lib/db.ts";
import { llmText } from "../lib/llm.ts";
import { publishThreads, threadsInsights, threadsMe, threadsPollResult, threadsReplies, threadsReply } from "../lib/threads.ts";
import fs from "node:fs";

const DRY = process.env.THREADS_ENGAGE_DRY === "1";
const themesData = JSON.parse(fs.readFileSync(new URL("../data/roundup-themes.json", import.meta.url), "utf8"));
const REPLIES_PER_DAY = 20;
const kstNow = () => new Date(Date.now() + 9 * 3600e3);
const kstDay = (d = kstNow()) => d.toISOString().slice(0, 10);
const cfg = async (k) => (await db.execute({ sql: "SELECT value FROM config WHERE key = ?", args: [k] })).rows[0]?.value ?? null;
const setCfg = (k, v) => db.execute({ sql: "INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))", args: [k, v] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hoursSince = (sqlTime) => (Date.now() - Date.parse(String(sqlTime).replace(" ", "T") + "Z")) / 3600e3;
const warn = (title, e) => console.log(`::warning title=${title}::${String(e?.message || e).replace(/\r?\n/g, " ").slice(0, 300)}`);

// ---------- 0) 동시 발행 글도 성과 표에 넣는다 ----------
async function syncCrossposts() {
  await db.execute(`INSERT OR IGNORE INTO threads_posts (id, kind, label, posted_at)
    SELECT threads_id, 'crosspost', place_name, created_at FROM posts
    WHERE threads_id IS NOT NULL AND threads_id != '' AND created_at > datetime('now', '-14 days')`);
}

// ---------- 1) 답글 응대 ----------
async function replyToReplies(me) {
  const done = Number((await db.execute({
    sql: "SELECT COUNT(*) n FROM threads_reply_log WHERE our_id IS NOT NULL AND date(created_at, '+9 hours') = ?", args: [kstDay()],
  })).rows[0].n);
  let budget = REPLIES_PER_DAY - done;
  if (budget <= 0) return console.log(`답글 응대: 오늘 ${done}개 — 상한`);
  const posts = (await db.execute(`SELECT id, kind, label FROM threads_posts
    WHERE kind IN ('question','dish','poll','crosspost') AND posted_at > datetime('now','-3 days') ORDER BY posted_at DESC`)).rows;
  for (const p of posts) {
    if (budget <= 0) break;
    let replies = [];
    try { replies = await threadsReplies(String(p.id)); } catch (e) { warn("threads-replies-read", e); return; }
    for (const r of replies) {
      if (budget <= 0) break;
      if (r.is_reply_owned_by_me || r.username === me || !r.text || r.text.trim().length < 2) continue;
      const seen = await db.execute({
        sql: "SELECT 1 FROM threads_reply_log WHERE reply_id = ? OR (post_id = ? AND username = ?)", args: [r.id, String(p.id), r.username ?? ""],
      });
      if (seen.rows.length) continue;
      const out = await llmText(
        `스레드에서 맛집 큐레이션 계정 '맛디깅'이 자기 글(${p.kind === "question" ? "동네 단골집을 묻는 글" : "맛집 소개 글"}: "${String(p.label ?? "").slice(0, 60)}")에 ` +
        `달린 답글에 다는 짧은 답장을 한 문장으로 써라. 존댓말, 35자 안팎, 이모지 최대 1개. 답글에 가게 이름이 있으면 그 이름을 짚어 고마워하고 ` +
        `"저장해둘게요"처럼 반응할 것. 가 봤다고 지어내지 말 것. 식당·음식은 긍정만(단점·비교 금지). 링크·해시태그·팔로우 요청 금지. ` +
        `답글이 부정적이거나 광고·스팸·무관한 내용이면 SKIP만 출력. 답장만 출력.\n답글: ${r.text.slice(0, 300)}`, { maxTokens: 120 });
      const text = out?.text?.trim().split("\n")[0].replace(/^["']|["']$/g, "");
      if (!text || /SKIP/i.test(text) || /http|#|팔로우|맞팔/.test(text)) {
        if (!DRY) await db.execute({ sql: "INSERT OR IGNORE INTO threads_reply_log (reply_id, post_id, username, our_id) VALUES (?, ?, ?, NULL)", args: [r.id, String(p.id), r.username ?? ""] });
        continue;
      }
      console.log(`↩ @${r.username}: ${r.text.slice(0, 40)} → ${text}`);
      if (DRY) { budget--; continue; }
      try {
        const ourId = await threadsReply(r.id, text);
        await db.execute({ sql: "INSERT OR REPLACE INTO threads_reply_log (reply_id, post_id, username, our_id) VALUES (?, ?, ?, ?)", args: [r.id, String(p.id), r.username ?? "", ourId] });
        budget--;
      } catch (e) { warn("threads-reply", e); return; } // 권한·스팸 제한이면 이번 회차는 멈춘다
      await sleep(20000 + Math.random() * 40000);
    }
  }
}

// ---------- 2) 이웃 추천 모음 ----------
async function recapQuestions(me) {
  const qs = (await db.execute(`SELECT id, region, food, posted_at FROM threads_posts
    WHERE kind = 'question' AND recap_id IS NULL AND posted_at < datetime('now','-20 hours') AND posted_at > datetime('now','-4 days')`)).rows;
  for (const q of qs) {
    let replies = [];
    try { replies = (await threadsReplies(String(q.id))).filter((r) => !r.is_reply_owned_by_me && r.username !== me && r.text); }
    catch (e) { warn("threads-recap-read", e); return; }
    const thing = q.food ? `${q.food}집` : "맛집";
    let names = [];
    if (replies.length) {
      const out = await llmText(
        `아래는 "${q.region} 단골 ${thing}"를 묻는 글에 달린 답글들이다. 답글에 실제로 적힌 가게(식당) 이름만 뽑아 JSON 배열로 출력하라. ` +
        `답글에 없는 이름을 만들지 말고, 체인 본사·지역명·메뉴명만 있는 것은 빼라. 없으면 []. JSON만 출력.\n` +
        replies.slice(0, 40).map((r) => `- ${r.text.slice(0, 160)}`).join("\n"), { maxTokens: 300 });
      try { names = JSON.parse(out?.text?.match(/\[[\s\S]*\]/)?.[0] ?? "[]"); } catch { names = []; }
      const all = replies.map((r) => r.text).join(" ");
      names = [...new Set(names.map((n) => String(n).trim()).filter((n) => n.length >= 2 && all.includes(n)))].slice(0, 8);
    }
    if (names.length < 2) {
      if (hoursSince(q.posted_at) > 70 && !DRY) await db.execute({ sql: "UPDATE threads_posts SET recap_id = 'none' WHERE id = ?", args: [q.id] });
      console.log(`모음 보류(${q.region} ${thing}): 가게 ${names.length}곳`);
      continue;
    }
    const text = `어제 ${q.region} 이웃분들이 알려주신 단골 ${thing} 🙌\n${names.map((n) => `· ${n}`).join("\n")}\n\n알려주셔서 감사해요! 저장해두고 다음 편 만들 때 꼭 참고할게요`;
    console.log(`📝 모음(${q.region}):\n${text}`);
    if (DRY) continue;
    const id = await publishThreads({ text, replyToId: String(q.id) });
    await db.execute({ sql: "UPDATE threads_posts SET recap_id = ? WHERE id = ?", args: [id ?? "none", q.id] });
    if (id) await db.execute({ sql: "INSERT OR REPLACE INTO threads_posts (id, kind, label, region, food) VALUES (?, 'recap', ?, ?, ?)", args: [id, `모음 ${q.region}`, q.region, q.food] });
  }
}

// ---------- 3) 다음 편 투표 ----------
const SOUP = new Set(["sundae", "dwaeji-busan", "kalguksu", "naengmyeon", "gukbap", "makguksu", "gomtang", "milmyeon-busan",
  "chueotang", "jjamppong", "samgyetang", "haejangguk", "gamjatang", "budaejjigae", "maeuntang", "eotang", "sundubu", "baeksuk", "gogiguksu-jeju"]);

async function pollStep() {
  const now = kstNow();
  const week = `${now.getUTCFullYear()}-${Math.floor((now - Date.UTC(now.getUTCFullYear(), 0, 1)) / 6048e5)}`;
  let poll = null;
  try { poll = JSON.parse((await cfg("threads_poll")) || "null"); } catch { /* 없음 */ }

  // 결과 정리: 올린 지 48시간 지났고 아직 반영 안 했으면
  if (poll && !poll.resolved && (Date.now() - Date.parse(poll.at)) > 48 * 3600e3) {
    let winner = null, how = "";
    try {
      const res = await threadsPollResult(poll.id);
      if (res && res.total > 0) {
        const best = Object.entries(res.pct).sort((a, b) => b[1] - a[1])[0];
        winner = poll.options[best[0]]; how = `투표 ${res.total}표`;
      }
    } catch (e) { warn("threads-poll-read", e); }
    if (!winner) { // 투표 결과를 못 읽거나 0표면 답글에 적힌 음식 이름을 센다
      const replies = await threadsReplies(poll.id).catch(() => []);
      const cnt = Object.fromEntries(Object.keys(poll.options).map((k) => [k, 0]));
      for (const r of replies) for (const [k, o] of Object.entries(poll.options)) {
        const i = Object.keys(poll.options).indexOf(k) + 1;
        if (String(r.text ?? "").includes(o.food) || new RegExp(`(^|\\D)${i}번?(\\D|$)`).test(String(r.text ?? ""))) cnt[k]++;
      }
      const best = Object.entries(cnt).sort((a, b) => b[1] - a[1])[0];
      if (best && best[1] > 0) { winner = poll.options[best[0]]; how = `답글 ${best[1]}표`; }
    }
    if (winner) {
      // 다음 전국 음식 슬롯(월·수·금·일) — 이미 다른 예약(국경선 후속편)이 있으면 그다음 슬롯
      let existing = null;
      try { existing = JSON.parse((await cfg("next_roundup_theme")) || "null"); } catch { /* 없음 */ }
      let d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      for (let i = 0; i < 14; i++) {
        d = new Date(d.getTime() + 864e5);
        const ds = d.toISOString().slice(0, 10);
        if ([0, 1, 3, 5].includes(d.getUTCDay()) && !(existing && existing.date >= ds)) break;
      }
      const date = d.toISOString().slice(0, 10);
      const theme = (themesData.themes ?? []).find((t) => t.key === winner.key);
      console.log(`🗳 투표 1위: ${winner.food}(${how}) → ${date} 모음집 예약`);
      if (!DRY && theme) {
        await setCfg("next_roundup_theme", JSON.stringify({ date, theme: { ...theme, fixedTop: "스레드 이웃이 고른" } }));
        const md = `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
        await publishThreads({ text: `투표해 주셔서 감사해요 🙌 1위는 ${winner.food}!\n${md} 저녁 5시 인스타 맛디깅에서 ${winner.food} 맛집 모음으로 준비해 볼게요`, replyToId: poll.id }).catch((e) => warn("threads-poll-result-post", e));
      }
    } else console.log("🗳 투표 결과 없음 — 예약 안 함");
    if (!DRY) await setCfg("threads_poll", JSON.stringify({ ...poll, resolved: true, winner: winner?.key ?? null }));
    return;
  }

  // 새 투표: 목요일 12시 이후, 이번 주에 아직 안 올렸으면
  if (now.getUTCDay() !== 4 || now.getUTCHours() < 12 || poll?.week === week) return;
  const recentKeys = (await db.execute("SELECT content_id FROM posts WHERE created_at > datetime('now','-14 days')")).rows.map((r) => String(r.content_id));
  const pool = (themesData.themes ?? []).filter((t) => !["area", "route", "density"].includes(t.mode) && !t.areaCodes && !t.maxPrice && !t.series && t.food
    && !recentKeys.some((c) => c.includes(`-${t.key}-`)));
  // 국물 3 + 그 외 1(국물이 조회 8배 — 2026-09-15 실측), 음식 이름은 서로 달라야
  const shuffle = (a) => a.map((x) => [Math.random(), x]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  const picks = [];
  for (const t of [...shuffle(pool.filter((t) => SOUP.has(t.key))).slice(0, 3), ...shuffle(pool.filter((t) => !SOUP.has(t.key))).slice(0, 1)]) {
    if (!picks.some((p) => p.food === t.food)) picks.push({ key: t.key, food: String(t.food).slice(0, 25) });
  }
  if (picks.length < 2) return console.log("🗳 투표 후보 부족");
  const keys = ["a", "b", "c", "d"].slice(0, picks.length);
  const options = Object.fromEntries(keys.map((k, i) => [k, picks[i]]));
  const text = `다음 전국 편 음식, 골라주세요! 🍽\n가장 많이 고른 음식으로 맛디깅이 맛집 모음을 만들어 올게요`;
  console.log(`🗳 새 투표: ${picks.map((p) => p.food).join(" / ")}`);
  if (DRY) return;
  let id = null;
  try {
    id = await publishThreads({ text, topicTag: "맛집추천", poll: { a: picks[0].food, b: picks[1].food, c: picks[2]?.food, d: picks[3]?.food } });
  } catch (e) {
    warn("threads-poll-attach", e); // 투표 첨부가 안 되면 답글로 고르는 글
    id = await publishThreads({ text: `${text}\n\n${picks.map((p, i) => `${i + 1}. ${p.food}`).join("\n")}\n\n답글로 번호나 음식 이름을 남겨주세요 🙌`, topicTag: "맛집추천" });
  }
  if (!id) return;
  await setCfg("threads_poll", JSON.stringify({ id, week, at: new Date().toISOString(), options, resolved: false }));
  await db.execute({ sql: "INSERT OR REPLACE INTO threads_posts (id, kind, label, tag) VALUES (?, 'poll', ?, '맛집추천')", args: [id, picks.map((p) => p.food).join("/")] });
}

// ---------- 4) 성과 ----------
async function collectMetrics() {
  const rows = (await db.execute(`SELECT id FROM threads_posts WHERE posted_at > datetime('now','-14 days')
    AND (metrics_at IS NULL OR metrics_at < datetime('now','-5 hours'))`)).rows;
  let n = 0;
  for (const r of rows) {
    try {
      const m = await threadsInsights(String(r.id));
      if (!m || DRY) continue;
      await db.execute({
        sql: "UPDATE threads_posts SET views = ?, likes = ?, replies = ?, reposts = ?, shares = ?, metrics_at = datetime('now') WHERE id = ?",
        args: [m.views ?? 0, m.likes ?? 0, m.replies ?? 0, (m.reposts ?? 0) + (m.quotes ?? 0), m.shares ?? 0, r.id],
      });
      n++;
    } catch (e) { warn("threads-insights", e); break; }
  }
  console.log(`📈 성과 갱신 ${n}/${rows.length}`);
}

async function main() {
  await initDb();
  const me = await threadsMe();
  if (!me) return console.log("Threads 미연결 — 건너뜀");
  await syncCrossposts();
  for (const [name, fn] of [["성과", collectMetrics], ["투표", pollStep], ["모음", () => recapQuestions(me)], ["답글 응대", () => replyToReplies(me)]]) {
    try { await fn(); } catch (e) { console.error(`${name} 실패:`, e); warn(`threads-engage-${name}`, e); }
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  console.log(`::error title=threads-engage::${String(e?.stack || e).replace(/\r?\n/g, " | ").slice(0, 600)}`);
  process.exit(1);
});
