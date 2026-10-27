// 특별 시리즈 테마 빌드(2026-10-27 사용자 결정) — KTX 노선 순례 + 골목 밀집도 서열.
//   npx tsx --env-file=.env scripts/build-series.mjs
// 결과는 data/roundup-themes.json의 mode:"route" / mode:"density" 테마로 들어간다(재실행 시 교체).
//
// route: KTX 노선 역마다 반경 3km 안 사진 있는 '그 음식' 식당 — 7역 이상 되는 노선×음식만.
//        발행 때는 역마다 다시 조회해 1곳씩, 노선 순서대로 6~8칸.
// density: 카카오 로컬로 역·상권 중심 반경 500m 안 '그 음식' 가게 수를 세어 많은 동네 순.
//          가게 수는 카카오 검색 결과 총 개수(사실 수치). 칸 사진은 그 반경 안 관광공사 식당 사진.
import fs from "node:fs";

const KAKAO = process.env.KAKAO_REST_KEY;
const TOUR = process.env.TOUR_API_KEY;
if (!KAKAO || !TOUR) { console.error("KAKAO_REST_KEY, TOUR_API_KEY 필요"); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kakao = async (path) => (await fetch(`https://dapi.kakao.com${path}`, { headers: { Authorization: `KakaoAK ${KAKAO}` }, signal: AbortSignal.timeout(15000) })).json();
// GitHub 러너 IP는 data.go.kr이 막는다 — CRON_SECRET이 있으면(러너) Vercel 프록시로(make-roundup tourCall과 같은 경로).
// 관광공사 API는 발행과 같은 하루 한도를 쓴다(2026-10-27 빌드 두 번에 한도 소진) — 그래서 새벽에만 돈다(series.yml).
let quotaHit = false;
async function tourNear(x, y, radius) {
  if (process.env.CRON_SECRET) {
    const base = (process.env.APP_BASE_URL || "https://insta-spot-bot.vercel.app").replace(/\/$/, "");
    const pq = new URLSearchParams({ endpoint: "locationBasedList2", contentTypeId: "39", numOfRows: "300", mapX: String(x), mapY: String(y), radius: String(radius), arrange: "E" });
    try {
      const r = await fetch(`${base}/api/tour-proxy?${pq}`, { headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` }, signal: AbortSignal.timeout(40000) });
      const j = await r.json();
      if (!Array.isArray(j.items)) { if (/LIMITED|요청제한/.test(JSON.stringify(j))) quotaHit = true; return []; }
      return j.items.filter((x) => x.firstimage && (x.cpyrhtDivCd === "Type1" || x.cpyrhtDivCd === "Type3"));
    } catch { return []; }
  }
  const u = `https://apis.data.go.kr/B551011/KorService2/locationBasedList2?serviceKey=${encodeURIComponent(TOUR)}&MobileOS=ETC&MobileApp=spot&_type=json&contentTypeId=39&numOfRows=300&mapX=${x}&mapY=${y}&radius=${radius}&arrange=E`;
  try {
    const j = await (await fetch(u, { signal: AbortSignal.timeout(20000) })).json();
    if (/LIMITED|요청제한/.test(JSON.stringify(j).slice(0, 400))) quotaHit = true;
    const it = j?.response?.body?.items?.item ?? [];
    return (Array.isArray(it) ? it : [it]).filter((x) => x.firstimage && (x.cpyrhtDivCd === "Type1" || x.cpyrhtDivCd === "Type3"));
  } catch { return []; }
}

const FOOD_GROUPS = [
  { key: "gukbap", food: "국밥", re: "국밥|해장국|순대국|순댓국|곰탕|설렁탕|수구레|소머리|내장탕" },
  { key: "noodle", food: "면", re: "칼국수|국수|냉면|막국수|밀면|짬뽕|우동|소바" },
];
const LINES = [
  { key: "gyeongbu", name: "경부선", from: "서울", to: "부산", stops: ["서울역", "광명역", "천안아산역", "오송역", "대전역", "김천구미역", "동대구역", "신경주역", "울산역", "부산역"] },
  { key: "honam", name: "호남선", from: "용산", to: "목포", stops: ["용산역", "광명역", "천안아산역", "오송역", "공주역", "익산역", "정읍역", "광주송정역", "나주역", "목포역"] },
  { key: "jeolla", name: "전라선", from: "용산", to: "여수", stops: ["용산역", "익산역", "전주역", "남원역", "곡성역", "구례구역", "순천역", "여천역", "여수엑스포역"] },
  { key: "gangneung", name: "강릉선", from: "서울", to: "강릉", stops: ["서울역", "청량리역", "양평역", "만종역", "횡성역", "둔내역", "평창역", "진부역", "강릉역"] },
];

async function stationXY(name) {
  const j = await kakao(`/v2/local/search/keyword.json?category_group_code=SW8&query=${encodeURIComponent(name)}`);
  let d = j.documents?.find((x) => x.place_name.startsWith(name)) ?? j.documents?.[0];
  if (!d) d = (await kakao(`/v2/local/search/keyword.json?query=${encodeURIComponent(name)}`)).documents?.[0];
  return d ? { x: Number(d.x), y: Number(d.y), sido: d.address_name.split(" ").slice(0, 2).join(" ") } : null;
}

// 이미 7일 안에 빌드했으면 건너뛴다(series.yml이 매일 새벽 시도) — FORCE=1이면 강제
const MARK = "data/series-built.json";
if (!process.env.FORCE) {
  try {
    const m = JSON.parse(fs.readFileSync(MARK, "utf8"));
    if (Date.now() - new Date(m.built).getTime() < 7 * 86400e3) { console.log(`최근 빌드(${m.built}) — 건너뜀`); process.exit(0); }
  } catch { /* 처음 */ }
}
const themes = [];
// 역 반경 3km면 국밥 노선이 4역뿐이었다(10/27 실측) — 5km로. 발행 수집기(collectRoutePlaces)도 같은 값.
const ROUTE_RADIUS = 5000;

// ---------- route ----------
const xy = {};
for (const ln of LINES) for (const s of ln.stops) if (!xy[s]) { xy[s] = await stationXY(s); await sleep(100); }
for (const ln of LINES) {
  for (const g of FOOD_GROUPS) {
    const re = new RegExp(g.re);
    const stops = [];
    for (const s of ln.stops) {
      const p = xy[s];
      if (!p) continue;
      const near = (await tourNear(p.x, p.y, ROUTE_RADIUS)).filter((x) => re.test(x.title ?? ""));
      if (near.length) stops.push({ name: s, x: p.x, y: p.y, sido: p.sido, n: near.length });
      await sleep(120);
    }
    console.log(`route ${ln.name}×${g.food}: ${stops.length}/${ln.stops.length}역 (${stops.map((s) => `${s.name}${s.n}`).join(" ")})`);
    if (stops.length >= 7) {
      themes.push({
        key: `route-${ln.key}-${g.key}`, mode: "route", series: "route", line: ln.name,
        food: g.food, keyword: g.food, foodRe: g.re, region: "전국", count: Math.min(8, stops.length), emoji: "🚄",
        routeLabel: `${ln.from}→${ln.to} KTX ${ln.name}`,
        tags: [`${g.food === "면" ? "면" : g.food}맛집`, "KTX여행", "기차여행"],
        stops: stops.map(({ name, x, y, sido }) => ({ name, x, y, sido })),
      });
    }
  }
}

// ---------- density ----------
const DENS_FOODS = [
  { key: "dwaeji", food: "돼지국밥", q: "돼지국밥" }, { key: "sundae", food: "순대국", q: "순대국" },
  { key: "gopchang", food: "곱창", q: "곱창" }, { key: "kalguksu", food: "칼국수", q: "칼국수" },
  { key: "naengmyeon", food: "냉면", q: "냉면" }, { key: "jjamppong", food: "짬뽕", q: "짬뽕" },
  { key: "gamjatang", food: "감자탕", q: "감자탕" }, { key: "jokbal", food: "족발", q: "족발" },
  { key: "haejangguk", food: "해장국", q: "해장국" }, { key: "dakgalbi", food: "닭갈비", q: "닭갈비" },
  { key: "tteokbokki", food: "떡볶이", q: "떡볶이" }, { key: "makguksu", food: "막국수", q: "막국수" },
];
const centers = [];
try {
  for (const s of JSON.parse(fs.readFileSync("data/stations.json", "utf8")).stations) centers.push({ name: s.name, region: s.region, x: s.x, y: s.y });
} catch { /* 역 목록 없음 */ }
const tf = "data/roundup-themes.json";
const raw = fs.readFileSync(tf, "utf8");
const tj = JSON.parse(raw);
for (const t of tj.themes) if (t.mode === "area" && t.tour?.mapX && t.series !== "station") centers.push({ name: t.keyword, region: t.region, x: t.tour.mapX, y: t.tour.mapY });
for (const ln of LINES) for (const s of ln.stops) if (xy[s] && !centers.some((c) => c.name === s)) centers.push({ name: s, region: xy[s].sido.split(" ")[0], x: xy[s].x, y: xy[s].y });
// 카카오 격자 수집에서 부산·대구 역이 거의 빠졌다(부산 14역) — 지방 도심 역을 이름으로 보강
const EXTRA = ["서면역", "남포역", "해운대역", "부산대역", "동래역", "연산역", "수영역", "광안역", "사상역", "덕천역", "하단역", "범내골역", "중앙역 부산", "토성역",
  "반월당역", "중앙로역 대구", "동대구역", "대구역", "성서산업단지역", "수성못역", "충장로 광주", "금남로4가역", "상무역", "둔산동 대전", "대전역", "은행동 대전",
  "전주 객사", "전주 한옥마을", "울산 삼산동", "창원 상남동", "청주 성안길", "춘천 명동", "원주 중앙시장", "수원역", "인계동 수원", "의정부역", "천안역", "포항 죽도시장"];
for (const n of EXTRA) {
  if (centers.some((c) => c.name === n)) continue;
  const d = (await kakao(`/v2/local/search/keyword.json?query=${encodeURIComponent(n)}`)).documents?.[0];
  if (d) centers.push({ name: n.split(" ")[0], region: d.address_name.split(" ")[0], x: Number(d.x), y: Number(d.y) });
  await sleep(80);
}
console.log(`밀집도 중심 ${centers.length}곳 × 음식 ${DENS_FOODS.length}`);
const dist = (a, b) => Math.hypot((a.x - b.x) * 88.2, (a.y - b.y) * 111) * 1000;
for (const f of DENS_FOODS) {
  const counts = [];
  for (const c of centers) {
    try {
      const j = await kakao(`/v2/local/search/keyword.json?category_group_code=FD6&query=${encodeURIComponent(f.q)}&x=${c.x}&y=${c.y}&radius=500&size=1`);
      const n = j.meta?.total_count ?? 0;
      if (n >= 5) counts.push({ ...c, n });
    } catch { /* skip */ }
    await sleep(60);
  }
  counts.sort((a, b) => b.n - a.n);
  const picked = [];
  for (const c of counts) {
    if (picked.length >= 10) break;
    if (picked.some((p) => dist(p, c) < 900)) continue; // 같은 골목을 두 번 세지 않게
    // 칸 사진은 상호에 음식 이름이 없어도 된다 — 그 음식이 실제로 보이는지는 발행 때 비전이 판정한다.
    // (상호 일치만 받았더니 12종 중 1종만 남았다, 10/27 실측) 음식 이름이 들어간 집을 앞에 세운다.
    const re = new RegExp(f.q.replace(/국$/, "국|국밥|탕"));
    const near = (await tourNear(c.x, c.y, 500)).sort((a, b) => re.test(b.title ?? "") - re.test(a.title ?? ""));
    await sleep(120);
    if (!near.length) continue; // 사진 없는 골목은 칸을 못 채운다
    picked.push({ ...c, cands: near.slice(0, 5).map((x) => ({ contentId: String(x.contentid), title: x.title, imageUrl: String(x.firstimage).replace(/^http:/, "https:"), addr: x.addr1 })) });
  }
  console.log(`density ${f.food}: ${picked.length}곳 — ${picked.slice(0, 6).map((p) => `${p.name} ${p.n}`).join(" · ")}`);
  if (picked.length >= 6) {
    themes.push({
      key: `dens-${f.key}`, mode: "density", series: "density", food: f.food, keyword: f.food, region: "전국", count: 6, emoji: "📊",
      tags: [`${f.food}맛집`, `${f.food}골목`, "맛집지도"],
      areas: picked.slice(0, 8),
    });
  }
}

if (quotaHit || !themes.length) {
  // 한도 초과로 빈 결과면 기존 테마를 지우지 않는다
  console.error(`관광공사 API 한도 초과 또는 결과 없음 — 테마 파일을 바꾸지 않음 (quotaHit=${quotaHit})`);
  process.exit(1);
}
tj.themes = tj.themes.filter((t) => t.mode !== "route" && t.mode !== "density").concat(themes);
fs.writeFileSync(MARK, JSON.stringify({ built: new Date().toISOString().slice(0, 10), route: themes.filter((t) => t.mode === "route").length, density: themes.filter((t) => t.mode === "density").length }) + "\n");
const nl = raw.includes("\r\n") ? "\r\n" : "\n";
fs.writeFileSync(tf, JSON.stringify(tj, null, 1).replace(/\n/g, nl) + nl);
console.log(`테마 반영: route ${themes.filter((t) => t.mode === "route").length} · density ${themes.filter((t) => t.mode === "density").length}`);
