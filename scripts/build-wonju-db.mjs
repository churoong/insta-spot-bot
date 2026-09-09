// 강원도 원주시 식당 DB 사전 빌드 → data/wonju-food.json
//
// 왜 빌드 방식인가: 원본이 파일데이터(odcloud)라 페이지를 8번 받아야 하고, 이미지·기본정보를
// 식당ID로 조인해야 한다. 발행 때마다 하면 20초씩 까먹으므로 서울판(build-seoul-db.mjs)과
// 같이 한 번 굳혀 두고 런타임은 파일만 읽는다.
//
// ⚠️ 이미지 원본 호스트(ukcooyocdlvo8099722.cdn.ntruss.com)는 DNS가 소멸했다.
//    같은 사업자(레드테이블) 버킷이라 서울판이 쓰는 호스트로 바꾸면 그대로 살아난다(실측 20/20).
//
// 사용법: npx tsx --env-file=.env scripts/build-wonju-db.mjs
import fs from "node:fs";

const KEY = process.env.TOUR_API_KEY;
if (!KEY) { console.error("TOUR_API_KEY 필요"); process.exit(1); }
const enc = encodeURIComponent(KEY);
const IMG = "15077719/v1/uddi:eef7996e-0355-484b-a815-c4bc22215ede";
const BASE = "15076726/v1/uddi:88f8bf5c-4273-4398-b726-c9778fcf4160";
const NEW_HOST = "https://qm9h2xsb8658.edge.naverncp.com";

// 순수 음식점만 (사용자 정책: 카페·제과·주점 제외)
const BAD_CAT = /(카페|커피|다방|제과|제빵|베이커리|아이스크림|디저트|찻집|호프|주점|술집|유흥|단란|노래|뷔페|출장|기타|패스트푸드)/;
const BAD_NAME = /(카페|까페|cafe|coffee|커피|로스터|베이커리|bakery|제과|과자|빵집|디저트|케이크|도넛|와플|아이스크림|젤라또|찻집|다방|와인바|펍|pub|호프|주점|술집|포차|맥주|브런치)/i;
const CHAIN = /(버거킹|맥도날드|롯데리아|KFC|맘스터치|서브웨이|파파존스|도미노|피자헛|미스터피자|김밥천국|본죽|한솥|빽다방|메가커피|투썸|스타벅스|이디야|명륜진사|원할머니|놀부|아웃백|빕스|한신포차|교촌|비비큐|BBQ|BHC|굽네|네네치킨|처갓집|60계|이삭토스트|역전우동|홍콩반점|새마을식당|신전떡볶이|엽기떡볶이)/i;

async function fetchAll(path, label) {
  const out = [];
  for (let page = 1; page <= 15; page++) {
    const r = await fetch(`https://api.odcloud.kr/api/${path}?page=${page}&perPage=500&serviceKey=${enc}`, {
      signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) throw new Error(`${label} HTTP ${r.status}: ${(await r.text()).slice(0, 120)}`);
    const j = await r.json();
    out.push(...(j.data ?? []));
    if (out.length >= (j.totalCount ?? 0) || !(j.data ?? []).length) break;
  }
  console.log(`  ${label}: ${out.length}행`);
  return out;
}

/** 죽은 호스트를 살아있는 버킷으로 교체 */
function swapHost(u) {
  const s = String(u ?? "");
  const m = s.match(/(\/public_data\/.*)$/);
  return m ? NEW_HOST + m[1] : s;
}

console.log("원주 식당 DB 빌드");
const [imgs, base] = [await fetchAll(IMG, "이미지"), await fetchAll(BASE, "기본정보")];

// 식당ID → 이미지 URL 목록
const byId = new Map();
for (const r of imgs) {
  const id = r["식당(ID)"];
  const url = swapHost(r["식당이미지(URL)"]);
  if (!id || !url.startsWith("http")) continue;
  if (!byId.has(id)) byId.set(id, []);
  byId.get(id).push(url);
}

const places = [];
for (const b of base) {
  const id = b["식당(ID)"];
  const imgList = byId.get(id);
  if (!imgList?.length) continue; // 사진 없으면 릴스에 못 쓴다
  const name = String(b["식당명"] ?? "").trim();
  const cat = String(b["영업신고증업태명"] ?? "");
  const state = String(b["식당상태"] ?? "");
  // 소스가 알려주는 폐업 정보는 그대로 존중한다(별도 폐업 조회를 붙이는 게 아니라 이미 있는 필드)
  if (/폐업|휴업/.test(state)) continue;
  if (!name || BAD_CAT.test(cat) || BAD_NAME.test(name) || CHAIN.test(name)) continue;
  const lat = Number(b["식당위도"]), lng = Number(b["식당경도"]);
  if (!lat || !lng) continue;
  const intro = String(b["음식점소개내용"] ?? "").replace(/\s+/g, " ").trim();
  places.push({
    id, name,
    addr: String(b["도로명주소"] || b["지번주소"] || "").trim(),
    lat, lng, cat,
    intro: intro.length > 10 ? intro.slice(0, 300) : "",
    imgs: imgList.slice(0, 6),
  });
}

fs.mkdirSync("data", { recursive: true });
fs.writeFileSync("data/wonju-food.json", JSON.stringify({ builtAt: new Date().toISOString().slice(0, 10), places }, null, 0));
console.log(`\n완료: ${places.length}곳 (사진 ${places.reduce((a, p) => a + p.imgs.length, 0)}장) → data/wonju-food.json`);
console.log(`샘플: ${places.slice(0, 3).map((p) => p.name).join(", ")}`);
