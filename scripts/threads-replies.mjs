/**
 * 스레드 "맛집 추천해 주세요" 글에 우리가 소개한 맛집으로 답글(2026-10-28 사용자 결정 — 계정 노출).
 * 공식 Threads API(키워드 검색 + 답글)라 노트북과 무관하고 비공식 로그인 위험이 없다. GitHub Actions에서 3시간마다.
 *  - 지역이 적힌 추천 요청 글만(지역을 못 찾으면 답하지 않는다 — 아무 데나 붙는 템플릿 답글은 스팸)
 *  - 그 지역에 소개한 집 2~3곳 + 맛디 지도 링크, 식당은 긍정만
 *  - 하루 8개, 같은 사람 7일에 한 번, 36시간 넘은 글·답글·우리 글은 건너뜀
 * 실행: THREADS_REPLY_DRY=1 npx tsx --env-file=.env scripts/threads-replies.mjs (답글 없이 후보만 출력)
 */
import { db, initDb } from "../lib/db.ts";
import { threadsKeywordSearch, threadsMe, threadsReply } from "../lib/threads.ts";

const DRY = process.env.THREADS_REPLY_DRY === "1";
const SITE = (process.env.PUBLIC_SITE_URL || "https://insta-spot-bot.vercel.app").replace(/\/$/, "");
const PER_DAY = 8;
const KEYWORDS = ["맛집 추천", "맛집 알려주세요", "맛집 어디", "밥집 추천", "국밥 맛집", "냉면 맛집", "칼국수 맛집", "뭐 먹지"];
const ASK = /(추천|알려|어디|있을까|있나요|있어요\?|ㅊㅊ|가볼만|갈만)/;
const FOODY = /(맛집|밥집|먹을\s?곳|뭐\s?먹|국밥|냉면|칼국수|순대|노포)/;
const SIDO = {
  서울특별시: "서울", 부산광역시: "부산", 대구광역시: "대구", 인천광역시: "인천", 광주광역시: "광주", 대전광역시: "대전",
  울산광역시: "울산", 세종특별자치시: "세종", 경기도: "경기", 강원도: "강원", 강원특별자치도: "강원", 충청북도: "충북",
  충청남도: "충남", 전라북도: "전북", 전북특별자치도: "전북", 전라남도: "전남", 경상북도: "경북", 경상남도: "경남", 제주특별자치도: "제주",
};
const kstDay = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const hasBatchim = (s) => { const c = s.charCodeAt(s.length - 1) - 0xac00; return c >= 0 && c < 11172 && c % 28 !== 0; };

/** map_pins 주소에서 지역 사전: 토큰 → 그 지역 핀들 */
async function regionIndex() {
  const rows = (await db.execute(`SELECT m.id, m.name, m.address, p.address AS lines FROM map_pins m
    JOIN posts p ON p.content_id = m.content_id WHERE p.status = 'published' ORDER BY m.id DESC`)).rows;
  const idx = new Map();
  const add = (tok, pin) => { if (tok && tok.length >= 2) (idx.get(tok) ?? idx.set(tok, []).get(tok)).push(pin); };
  for (const r of rows) {
    const [a, b] = String(r.address ?? "").trim().split(/\s+/);
    const rank = Number(String(r.lines ?? "").split("\n").find((l) => l.includes(String(r.name)))?.match(/^(\d+)\./)?.[1] ?? 9);
    const pin = { id: Number(r.id), name: String(r.name), rank };
    if (SIDO[a]) add(SIDO[a], pin);
    if (b && /[시군구]$/.test(b)) {
      add(b, pin);
      const stem = b.slice(0, -1);
      if (stem.length >= 2) add(stem, pin); // "해운대구" → "해운대" (중구·동구 같은 한 글자는 모호해서 안 씀)
    }
  }
  return idx;
}

function pickRegion(text, idx) {
  let best = null;
  for (const tok of idx.keys()) if (text.includes(tok) && (!best || tok.length > best.length)) best = tok;
  return best;
}

function replyText(region, pins) {
  const names = pins.map((p) => p.name);
  const link = pins.length === 1 ? `${SITE}/m/${pins[0].id}` : `${SITE}/m`;
  const r = `${region}${hasBatchim(region) ? "이라면" : "라면"}`;
  const variants = [
    `${region} 쪽이면 저희가 소개했던 ${names.join(", ")} 추천드려요 🍲 위치는 맛디 지도에 모아뒀어요 ${link}`,
    `${r} ${names.join("·")} 어떠세요? 맛디깅에서 소개한 곳들이에요 😊 지도 → ${link}`,
    `${region} 맛집으로 ${names.join(", ")} 꼭 가보세요! 다 맛있게 드셨으면 좋겠어요 🙌 ${link}`,
  ];
  return variants[Math.floor(Math.random() * variants.length)];
}

async function main() {
  await initDb();
  await db.execute(`CREATE TABLE IF NOT EXISTS threads_replies (
    post_id TEXT PRIMARY KEY, username TEXT, region TEXT, reply_id TEXT, created_at TEXT DEFAULT (datetime('now')))`);
  const me = await threadsMe();
  if (!me) return console.log("Threads 미연결 — 건너뜀");
  const today = Number((await db.execute({
    sql: "SELECT COUNT(*) AS n FROM threads_replies WHERE reply_id IS NOT NULL AND date(created_at, '+9 hours') = ?", args: [kstDay()],
  })).rows[0]?.n ?? 0);
  if (today >= PER_DAY) return console.log(`오늘 답글 ${today}개 — 상한`);
  const idx = await regionIndex();
  let done = today;
  for (const kw of KEYWORDS.sort(() => Math.random() - 0.5).slice(0, 4)) {
    let hits;
    try {
      hits = await threadsKeywordSearch(kw);
    } catch (e) {
      // 권한(threads_keyword_search) 미승인이 가장 흔한 원인 — 사유를 남기고 끝낸다
      console.log(`::error title=threads-replies::${String(e).slice(0, 300)}`);
      return;
    }
    console.log(`"${kw}" 결과 ${hits.length}건`);
    for (const h of hits) {
      if (done >= PER_DAY) break;
      const text = String(h.text ?? "");
      if (h.username === me || h.is_reply || Date.now() - Date.parse(h.timestamp) > 36 * 3600e3) continue;
      if (!ASK.test(text) || !FOODY.test(text)) continue;
      const seen = await db.execute({
        sql: "SELECT 1 FROM threads_replies WHERE post_id = ? OR (username = ? AND created_at > datetime('now', '-7 days'))",
        args: [h.id, h.username],
      });
      if (seen.rows.length) continue;
      const region = pickRegion(text, idx);
      if (!region) continue;
      const pins = [...new Map(idx.get(region).sort((a, b) => a.rank - b.rank).map((p) => [p.name, p])).values()].slice(0, 3);
      if (pins.length < 2) continue;
      const reply = replyText(region, pins);
      console.log(`→ @${h.username} (${region}) ${h.permalink}\n   ${reply}`);
      if (DRY) continue;
      try {
        const id = await threadsReply(h.id, reply);
        await db.execute({ sql: "INSERT OR REPLACE INTO threads_replies (post_id, username, region, reply_id) VALUES (?, ?, ?, ?)", args: [h.id, h.username, region, id] });
        done++;
        console.log("🧵 답글:", id);
      } catch (e) {
        await db.execute({ sql: "INSERT OR REPLACE INTO threads_replies (post_id, username, region, reply_id) VALUES (?, ?, ?, NULL)", args: [h.id, h.username, region] });
        console.log(`::error title=threads-replies::${String(e).slice(0, 300)}`);
        return; // 권한·스팸 차단이면 이어서 시도하지 않는다
      }
      await new Promise((r) => setTimeout(r, 30000 + Math.random() * 60000));
    }
  }
  console.log(`오늘 답글 ${done}/${PER_DAY}`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  console.log(`::error title=threads-replies::${String(e?.stack || e).replace(/\r?\n/g, " | ").slice(0, 600)}`);
  process.exit(1);
});
