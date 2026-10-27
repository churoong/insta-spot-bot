// 지하철역 맛집 시리즈(2026-10-27 사용자 결정)용 역 목록 빌드.
//   npx tsx --env-file=.env scripts/build-stations.mjs
// 1) 카카오 로컬 카테고리 검색(SW8 지하철역)을 도시 격자로 훑어 역 좌표를 모은다(무료, KAKAO_REST_KEY).
// 2) 역마다 반경 RADIUS 안 사진 있는 음식점 수를 잰다 — TourAPI + 서울 음식관광 DB(카페·주점 제외).
//    상권 테마와 같은 안정선(풀 20곳+)을 넘는 역만 테마로 쓴다(비전 탈락 감안).
// 3) data/stations.json(측정 결과 전부)과 data/roundup-themes.json(통과한 역만 series:"station")을 쓴다.
import fs from "node:fs";

const KAKAO = process.env.KAKAO_REST_KEY;
const TOUR = process.env.TOUR_API_KEY;
if (!KAKAO || !TOUR) { console.error("KAKAO_REST_KEY, TOUR_API_KEY 필요"); process.exit(1); }
const RADIUS = 700;
const MIN_POOL = 20;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BAD_CAT = /^A0502(0900|1000)/;
const BAD_NAME = /(카페|까페|cafe|coffee|커피|로스터|베이커리|bakery|제과|빵집|디저트|dessert|케이크|도넛|와플|아이스크림|젤라또|빙수|호프|포차|술집|bar|펍|pub|와인|칵테일)/i;

// 도시별 격자 범위 [남, 서, 북, 동]
const CITIES = [
  ["서울", [37.42, 126.76, 37.70, 127.19]],
  ["경기", [37.25, 126.70, 37.42, 127.15]],
  ["인천", [37.38, 126.60, 37.60, 126.76]],
  ["부산", [35.05, 128.90, 35.30, 129.22]],
  ["대구", [35.78, 128.48, 35.95, 128.70]],
  ["대전", [36.28, 127.30, 36.40, 127.46]],
  ["광주", [35.10, 126.78, 35.20, 126.95]],
];
const STEP = 0.03;

async function kakaoRect(rect, page) {
  const u = `https://dapi.kakao.com/v2/local/search/category.json?category_group_code=SW8&rect=${rect}&page=${page}&size=15`;
  const r = await fetch(u, { headers: { Authorization: `KakaoAK ${KAKAO}` }, signal: AbortSignal.timeout(15000) });
  return r.json();
}

const base = (n) => String(n).replace(/\s*(\d+호선|[가-힣A-Za-z]+선|경의중앙선|공항철도|신분당선|수인분당선).*$/, "").replace(/\(.*?\)/g, "").trim();

async function collectStations() {
  const by = new Map();
  for (const [city, [s, w, n, e]] of CITIES) {
    for (let y = s; y < n; y += STEP) {
      for (let x = w; x < e; x += STEP) {
        const rect = `${x.toFixed(4)},${y.toFixed(4)},${(x + STEP).toFixed(4)},${(y + STEP).toFixed(4)}`;
        for (let page = 1; page <= 3; page++) {
          const j = await kakaoRect(rect, page);
          for (const d of j.documents ?? []) {
            const name = base(d.place_name);
            if (!name.endsWith("역")) continue;
            const key = `${name}|${d.address_name.split(" ")[0]}`;
            const cur = by.get(key) ?? { name, region: city, sido: d.address_name.split(" ")[0], xs: [], ys: [], id: d.id };
            cur.xs.push(Number(d.x)); cur.ys.push(Number(d.y));
            by.set(key, cur);
          }
          if (j.meta?.is_end !== false) break;
          await sleep(120);
        }
        await sleep(80);
      }
    }
    console.log(`${city}: 누적 ${by.size}역`);
  }
  return [...by.values()].map((v) => ({
    name: v.name, region: v.region, sido: v.sido, id: v.id,
    x: +(v.xs.reduce((a, b) => a + b, 0) / v.xs.length).toFixed(5),
    y: +(v.ys.reduce((a, b) => a + b, 0) / v.ys.length).toFixed(5),
  }));
}

const R = 6371e3;
const dist = (ax, ay, bx, by) => {
  const toR = (d) => (d * Math.PI) / 180;
  const dLat = toR(by - ay), dLng = toR(bx - ax);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toR(ay)) * Math.cos(toR(by)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
};

const seoulDb = (() => {
  try {
    const j = JSON.parse(fs.readFileSync("data/seoul-food.json", "utf8"));
    return (Array.isArray(j) ? j : Object.values(j).find(Array.isArray) ?? []).filter((p) => p.lat && p.lng && p.imgs?.length);
  } catch { return []; }
})();

async function pool(st) {
  const u = `https://apis.data.go.kr/B551011/KorService2/locationBasedList2?serviceKey=${encodeURIComponent(TOUR)}&MobileOS=ETC&MobileApp=spot&_type=json&contentTypeId=39&numOfRows=300&mapX=${st.x}&mapY=${st.y}&radius=${RADIUS}&arrange=E`;
  let tour = 0;
  try {
    const j = await (await fetch(u, { signal: AbortSignal.timeout(20000) })).json();
    let it = j?.response?.body?.items?.item ?? [];
    it = Array.isArray(it) ? it : [it];
    tour = it.filter((x) => x.firstimage && (x.cpyrhtDivCd === "Type1" || x.cpyrhtDivCd === "Type3") && !BAD_CAT.test(x.cat3 ?? "") && !BAD_NAME.test(x.title ?? "")).length;
  } catch { /* 0 */ }
  const seoul = st.sido.startsWith("서울") ? seoulDb.filter((p) => dist(st.x, st.y, Number(p.lng), Number(p.lat)) <= RADIUS && !BAD_NAME.test(p.name)).length : 0;
  // 실제 상권 수집기(supplementNearby)와 같은 상한: 보조 소스는 풀(24)의 절반 또는 TourAPI 부족분까지
  const cap = Math.max(Math.ceil(24 / 2), 24 - tour);
  return { tour, seoul, total: tour + Math.min(seoul, cap) };
}

const stations = await collectStations();
console.log(`역 ${stations.length}곳 — 풀 측정 시작(반경 ${RADIUS}m)`);
for (const st of stations) {
  Object.assign(st, await pool(st));
  await sleep(150);
}
stations.sort((a, b) => b.total - a.total);
fs.writeFileSync("data/stations.json", JSON.stringify({ built: new Date().toISOString().slice(0, 10), radius: RADIUS, stations }, null, 1));
const ok = stations.filter((s) => s.total >= MIN_POOL);
console.log(`풀 ${MIN_POOL}+ 역: ${ok.length}/${stations.length}`);
console.log(ok.slice(0, 30).map((s) => `${s.name}(${s.region} ${s.total})`).join(" · "));

// 테마 파일에 반영(기존 station 테마는 교체)
const tf = "data/roundup-themes.json";
const raw = fs.readFileSync(tf, "utf8");
const t = JSON.parse(raw);
t.themes = t.themes.filter((x) => x.series !== "station");
for (const s of ok) {
  const short = s.name.replace(/역$/, "");
  t.themes.push({
    key: `stn-${s.id}`,
    mode: "area",
    series: "station",
    keyword: s.name,
    region: s.region,
    count: 6,
    emoji: "🚇",
    tags: [`${short}역맛집`, `${short}맛집`, `${s.region}맛집`],
    tour: { mapX: s.x, mapY: s.y, radius: RADIUS },
  });
}
const nl = raw.includes("\r\n") ? "\r\n" : "\n";
fs.writeFileSync(tf, JSON.stringify(t, null, 1).replace(/\n/g, nl) + nl);
console.log(`테마 반영: 지하철역 ${ok.length}개 (series:"station")`);
