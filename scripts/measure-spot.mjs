// 상권 후보 풀 측정 — 지명(또는 좌표) → TourAPI 좌표 반경 음식점 수(카페·주점 제외, 사진 보유).
// 모음집 한 편에 6곳 + 비전 탈락을 감안하면 풀 20곳 이상이 안정선.
//
//   npx tsx --env-file=.env scripts/measure-spot.mjs '[{"name":"성수역","x":127.0558,"y":37.5446},{"name":"애월 한담해변"}]'
//   좌표가 없으면 Nominatim(OSM)으로 지오코딩(무료·키 불필요, 1초 간격).
//   출력: 한 줄에 하나씩 JSON {name,x,y,r1500,r2000,geocoded}
import fs from "node:fs";

const KEY = process.env.TOUR_API_KEY;
if (!KEY) { console.error("TOUR_API_KEY 필요"); process.exit(1); }
const BASE = "https://apis.data.go.kr/B551011/KorService2";
const BAD_CAT = /^A0502(0900|1000)/;
const BAD_NAME = /(카페|까페|cafe|coffee|커피|로스터|베이커리|bakery|제과|빵집|디저트|dessert|케이크|도넛|와플|아이스크림|젤라또|치즈|초콜|티하우스|찻집|다방|와인바|펍|pub|호프|주점|술집|포차|맥주)/i;

const arg = process.argv[2];
const input = arg?.endsWith(".json") ? JSON.parse(fs.readFileSync(arg, "utf8")) : JSON.parse(arg ?? "[]");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function geocode(name) {
  const u = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=kr&q=${encodeURIComponent(name)}`;
  const r = await fetch(u, { headers: { "User-Agent": "insta-spot-bot/measure (contact: repo owner)" }, signal: AbortSignal.timeout(15000) });
  const j = await r.json();
  if (!Array.isArray(j) || !j.length) return null;
  return { x: Number(j[0].lon), y: Number(j[0].lat) };
}

async function count(x, y, radius) {
  const u = `${BASE}/locationBasedList2?serviceKey=${encodeURIComponent(KEY)}&MobileOS=ETC&MobileApp=spot&_type=json&contentTypeId=39&numOfRows=300&mapX=${x}&mapY=${y}&radius=${radius}`;
  try {
    const j = await (await fetch(u, { signal: AbortSignal.timeout(20000) })).json();
    const it = j.response?.body?.items?.item;
    const arr = Array.isArray(it) ? it : it ? [it] : [];
    return arr.filter((a) => a.firstimage && !BAD_CAT.test(String(a.cat3 ?? "")) && !BAD_NAME.test(String(a.title ?? ""))).length;
  } catch (e) {
    return -1; // 호출 실패(한도 등)
  }
}

for (const c of input) {
  let { x, y } = c;
  let geocoded = false;
  if (!(x && y)) {
    const g = await geocode(c.name);
    await sleep(1100);
    if (!g) { console.log(JSON.stringify({ name: c.name, error: "geocode 실패" })); continue; }
    ({ x, y } = g); geocoded = true;
  }
  const r1500 = await count(x, y, 1500);
  const r2000 = await count(x, y, 2000);
  console.log(JSON.stringify({ name: c.name, x, y, r1500, r2000, geocoded }));
}
