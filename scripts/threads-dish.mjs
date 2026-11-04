/**
 * 스레드 "오늘의 한 그릇"(2026-11-04 사용자 결정 — 스레드 아이디어 3). 매일 낮 한 번, 소개했던 식당 한 곳을
 * 3~4줄 글로 올린다. 스레드는 글 위주라 영상 동시 발행과 별도로 읽히는 글이 필요하다.
 *  - 내용은 우리가 이미 발행한 캡션의 그 식당 설명 줄(긍정만 쓰도록 만든 문장)과 편 제목·순위뿐 — 새 사실을 지어내지 않는다
 *  - 60일 안에 쓴 식당은 다시 안 쓴다(config threads_dish_used), 하루 1회(threads_dish_day)
 * 실행: THREADS_DISH_DRY=1 npx tsx --env-file=.env scripts/threads-dish.mjs
 */
import { db, initDb } from "../lib/db.ts";
import { publishThreads } from "../lib/threads.ts";

const DRY = process.env.THREADS_DISH_DRY === "1";
const SIDO = {
  서울특별시: "서울", 부산광역시: "부산", 대구광역시: "대구", 인천광역시: "인천", 광주광역시: "광주", 대전광역시: "대전",
  울산광역시: "울산", 세종특별자치시: "세종", 경기도: "경기", 강원도: "강원", 강원특별자치도: "강원", 충청북도: "충북",
  충청남도: "충남", 전라북도: "전북", 전북특별자치도: "전북", 전라남도: "전남", 경상북도: "경북", 경상남도: "경남", 제주특별자치도: "제주",
};
const kstDay = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const cfg = async (k) => (await db.execute({ sql: "SELECT value FROM config WHERE key = ?", args: [k] })).rows[0]?.value ?? null;
const setCfg = (k, v) => db.execute({ sql: "INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))", args: [k, v] });
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 편 제목에서 음식명("요즘 난리 난 냉면 6대 맛집" → 냉면). 지역·역 편이면 null */
function foodOf(title) {
  const t = String(title ?? "").match(/(\S+)\s+\d+대\s*맛집/)?.[1] ?? "";
  return /^[가-힣]{1,6}$/.test(t) && !/(는|한|운|은|난|할|던|의)$/.test(t) ? t : null;
}

/** 캡션에서 그 식당 줄("3. 상호 …")의 순위와 바로 아래 설명 줄 */
function detailOf(caption, name) {
  const lines = String(caption ?? "").split("\n");
  const i = lines.findIndex((l) => new RegExp(`^\\s*(\\d+)\\.\\s*${esc(name)}(\\s|$)`).test(l));
  if (i < 0) return null;
  const rank = Number(lines[i].match(/^\s*(\d+)\./)[1]);
  const detail = (lines[i + 1] ?? "").trim();
  if (!detail || /^\d+\./.test(detail) || detail.length < 15) return null;
  return { rank, detail: detail.slice(0, 220) };
}

async function main() {
  await initDb();
  const today = kstDay();
  if (!DRY && (await cfg("threads_dish_day")) === today) return console.log("오늘 한 그릇 글은 이미 올렸다");
  let used = [];
  try { used = JSON.parse((await cfg("threads_dish_used")) || "[]"); } catch { /* 처음 */ }
  const recent = new Set(used.filter((u) => Date.now() - Date.parse(u.at) < 60 * 864e5).map((u) => u.name));

  const rows = (await db.execute(`SELECT m.name, m.address, p.place_name AS title, p.caption FROM map_pins m
    JOIN posts p ON p.content_id = m.content_id WHERE p.status = 'published' ORDER BY RANDOM() LIMIT 300`)).rows;
  let pick = null;
  for (const r of rows) {
    const name = String(r.name);
    if (recent.has(name)) continue;
    const d = detailOf(r.caption, name);
    const [a, b] = String(r.address ?? "").trim().split(/\s+/);
    if (!d || !SIDO[a]) continue;
    pick = { name, ...d, title: String(r.title ?? "").replace(/^.*\|\s*/, ""), sido: SIDO[a], region: `${SIDO[a]} ${b ?? ""}`.trim(), food: foodOf(r.title) };
    break;
  }
  if (!pick) return console.log("올릴 식당이 없다(설명 줄이 있는 미사용 식당 없음)");
  const text = `${pick.region} ${pick.name} 🍲\n${pick.detail}\n\n맛디깅 "${pick.title}" 편에서 ${pick.rank}위로 소개한 집이에요.\n근처 가시면 들러보세요 🙌`.slice(0, 480);
  const topicTag = pick.food ? `${pick.food}맛집` : `${pick.sido}맛집`;
  console.log(`식당: ${pick.name} / 태그: ${topicTag}\n${text}`);
  if (DRY) return;
  const id = await publishThreads({ text, topicTag });
  if (!id) return console.log("Threads 미연결 — 건너뜀");
  await setCfg("threads_dish_day", today);
  await setCfg("threads_dish_used", JSON.stringify([...used.filter((u) => Date.now() - Date.parse(u.at) < 90 * 864e5), { name: pick.name, at: new Date().toISOString(), id }]));
  await db.execute({
    sql: "INSERT OR REPLACE INTO threads_posts (id, kind, label, region, food, tag) VALUES (?, 'dish', ?, ?, ?, ?)",
    args: [id, pick.name, pick.region, pick.food, topicTag],
  });
  console.log("🧵 오늘의 한 그릇:", id);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  console.log(`::error title=threads-dish::${String(e?.stack || e).replace(/\r?\n/g, " | ").slice(0, 600)}`);
  process.exit(1);
});
