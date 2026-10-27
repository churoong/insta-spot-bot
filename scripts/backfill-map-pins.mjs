// 전국 맛집 지도 프로젝트 — 지금까지 발행한 모음집·큐레이션의 식당을 map_pins에 채운다(한 번만).
//   npx tsx --env-file=.env scripts/backfill-map-pins.mjs
// posts.address는 "1. 상호 — 주소 2. 상호 — 주소 …" 형식. 카카오 주소 검색 → 실패하면 상호 키워드 검색.
const { db, initDb } = await import("../lib/db.ts");
await initDb();
const KEY = process.env.KAKAO_REST_KEY;
if (!KEY) { console.error("KAKAO_REST_KEY 필요"); process.exit(1); }
const get = async (u) => (await fetch(u, { headers: { Authorization: `KakaoAK ${KEY}` }, signal: AbortSignal.timeout(8000) })).json();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const rows = (await db.execute(
  `SELECT content_id, address FROM posts WHERE status = 'published'
     AND (content_id LIKE 'roundup-%' OR content_id LIKE 'countdown-%' OR content_id LIKE 'carousel-%') ORDER BY id`
)).rows;
let added = 0, miss = 0, seen = 0;
for (const r of rows) {
  const items = [...String(r.address ?? "").matchAll(/\d\.\s*(.+?)\s+—\s+(.+?)(?=\s+\d\.\s|$)/g)];
  for (const [, name, addr] of items) {
    seen++;
    let g = null;
    try {
      const a = String(addr).split(/\s{2,}|\(/)[0].trim();
      const d = (await get(`https://dapi.kakao.com/v2/local/search/address.json?query=${encodeURIComponent(a)}`)).documents?.[0];
      if (d) g = { x: Number(d.x), y: Number(d.y) };
      else {
        const d2 = (await get(`https://dapi.kakao.com/v2/local/search/keyword.json?category_group_code=FD6&query=${encodeURIComponent(name)}`)).documents?.[0];
        if (d2) g = { x: Number(d2.x), y: Number(d2.y) };
      }
    } catch { /* 건너뜀 */ }
    if (!g) { miss++; continue; }
    const res = await db.execute({
      sql: "INSERT OR IGNORE INTO map_pins (name, address, x, y, content_id) VALUES (?, ?, ?, ?, ?)",
      args: [name.trim(), addr.trim(), g.x, g.y, r.content_id],
    });
    added += res.rowsAffected ?? 0;
    await sleep(60);
  }
}
const total = (await db.execute("SELECT COUNT(*) AS n FROM map_pins")).rows[0].n;
console.log(`게시물 ${rows.length}건 · 식당 ${seen}곳 → 새 핀 ${added} · 좌표 실패 ${miss} · 지도 총 ${total}곳`);
process.exit(0);
