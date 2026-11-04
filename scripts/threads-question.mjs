/**
 * 스레드 동네 질문 글(2026-10-28 사용자 결정 — 계정 노출). 매일 저녁 한 번, 우리가 소개한 동네 하나를 골라
 * "○○구 사시는 분들, 단골 ○○집 어디세요?"를 올린다. 스레드는 댓글이 달리는 글을 멀리 퍼뜨리고,
 * 동네 이름이 들어가면 그 동네 사람이 반응한다. 이미 있는 발행 권한(threads_content_publish)만 쓴다.
 *  - 소개 맛집 2곳 이상인 시군구만, 최근 30일 안에 물어본 동네는 건너뜀(config threads_q_used)
 *  - 하루 1회(config threads_q_day = KST 날짜), 링크 없음(스레드는 링크 글을 덜 퍼뜨린다)
 *  - 식당은 긍정만, 방문 주장 없음
 * 실행: THREADS_Q_DRY=1 npx tsx --env-file=.env scripts/threads-question.mjs
 */
import { db, initDb } from "../lib/db.ts";
import { publishThreads } from "../lib/threads.ts";

const DRY = process.env.THREADS_Q_DRY === "1";
const SIDO = {
  서울특별시: "서울", 부산광역시: "부산", 대구광역시: "대구", 인천광역시: "인천", 광주광역시: "광주", 대전광역시: "대전",
  울산광역시: "울산", 세종특별자치시: "세종", 경기도: "경기", 강원도: "강원", 강원특별자치도: "강원", 충청북도: "충북",
  충청남도: "충남", 전라북도: "전북", 전북특별자치도: "전북", 전라남도: "전남", 경상북도: "경북", 경상남도: "경남", 제주특별자치도: "제주",
};
const kstDay = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const cfg = async (k) => (await db.execute({ sql: "SELECT value FROM config WHERE key = ?", args: [k] })).rows[0]?.value ?? null;
const setCfg = (k, v) => db.execute({ sql: "INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))", args: [k, v] });

/** 편 제목에서 음식명 — "전국 돼지국밥 6대 맛집" → "돼지국밥". 지역·역 편("○○ 부근 맛집", 옛 "6대 맛집 · 성수동")이면 null */
function foodOf(title) {
  const t = String(title ?? "").match(/(\S+)\s+\d+대\s*맛집/)?.[1] ?? "";
  return /^[가-힣]{1,6}$/.test(t) && !/(는|한|운|은|난|할|던|의)$/.test(t) ? t : null;
}

async function main() {
  await initDb();
  const today = kstDay();
  if (!DRY && (await cfg("threads_q_day")) === today) return console.log("오늘 질문 글은 이미 올렸다");
  let used = [];
  try { used = JSON.parse((await cfg("threads_q_used")) || "[]"); } catch { /* 처음 */ }
  const recent = new Set(used.filter((u) => Date.now() - Date.parse(u.at) < 30 * 864e5).map((u) => u.region));

  const rows = (await db.execute(`SELECT m.name, m.address, p.place_name AS title FROM map_pins m
    JOIN posts p ON p.content_id = m.content_id WHERE p.status = 'published'`)).rows;
  // 동네 × 음식으로 묶는다(2026-11-04 사용자: "강남구 냉면집을 묻는데 소개한 곳이 브루하우스·호족반이면 쌩뚱맞다").
  // 질문하는 음식과 같이 적는 두 곳이 반드시 같은 음식 편에서 나오게 하고, 음식 없는 지역·역 편 식당은
  // "단골 맛집" 질문에만 쓴다.
  const groups = new Map();
  for (const r of rows) {
    const [a, b] = String(r.address ?? "").trim().split(/\s+/);
    if (!SIDO[a] || !b || !/[시군구]$/.test(b)) continue;
    const region = `${SIDO[a]} ${b}`;
    const food = foodOf(r.title);
    const k = `${region}|${food ?? ""}`;
    (groups.get(k) ?? groups.set(k, { region, food, names: new Set() }).get(k)).names.add(String(r.name));
  }
  const cands = [...groups.values()].filter((g) => g.names.size >= 2 && !recent.has(g.region));
  if (!cands.length) return console.log("물어볼 동네가 없다(모두 최근 30일 안에 사용)");
  // 소개한 집이 많을수록 잘 뽑히게(√ 가중), 음식이 정해진 질문이 더 구체적이라 1.5배
  const w = cands.map((g) => Math.sqrt(g.names.size) * (g.food ? 1.5 : 1));
  let x = Math.random() * w.reduce((a, b) => a + b, 0), pick = cands[0];
  for (let i = 0; i < cands.length; i++) { x -= w[i]; if (x <= 0) { pick = cands[i]; break; } }
  const { region, food } = pick;
  const [n1, n2] = [...pick.names].sort(() => Math.random() - 0.5);
  const thing = food ? `${food}집` : "맛집";
  const variants = [
    `${region} 사시는 분들 🙌 단골 ${thing} 어디세요?\n저희는 ${n1}, ${n2} 소개했었는데 여러분 원픽도 궁금해요!`,
    `${region} ${thing} 원픽 하나만 알려주세요 😋\n(맛디깅이 소개한 곳: ${n1} · ${n2})`,
    `${region}에서 ${food ?? "밥"} 생각날 때 꼭 가는 곳 있으세요? 🍲\n${n1}, ${n2} 말고 숨은 단골집도 듣고 싶어요`,
  ];
  const text = variants[Math.floor(Math.random() * variants.length)];
  // 토픽 태그 A/B(2026-11-04): 날짜 짝·홀로 "<시도>맛집"·"맛집추천"을 번갈아 — threads_posts.tag로 조회수 비교
  const dayNo = Math.floor((Date.now() + 9 * 3600e3) / 864e5);
  const topicTag = dayNo % 2 === 0 ? `${region.split(" ")[0]}맛집` : "맛집추천";
  console.log(`동네: ${region} / 음식: ${food ?? "-"} / 태그: ${topicTag}\n${text}`);
  if (DRY) return;
  const id = await publishThreads({ text, topicTag });
  if (!id) return console.log("Threads 미연결 — 건너뜀");
  await setCfg("threads_q_day", today);
  await db.execute({
    sql: "INSERT OR REPLACE INTO threads_posts (id, kind, label, region, food, tag) VALUES (?, 'question', ?, ?, ?, ?)",
    args: [id, text.split("\n")[0].slice(0, 80), region, food ?? null, topicTag],
  });
  await setCfg("threads_q_used", JSON.stringify([...used.filter((u) => Date.now() - Date.parse(u.at) < 60 * 864e5), { region, at: new Date().toISOString(), id }]));
  console.log("🧵 동네 질문 글:", id);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  console.log(`::error title=threads-question::${String(e?.stack || e).replace(/\r?\n/g, " | ").slice(0, 600)}`);
  process.exit(1);
});
