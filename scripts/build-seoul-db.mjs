// 서울관광재단 음식관광 DB(레드테이블 OpenAPI) → data/seoul-food.json 빌드.
//
// 왜 빌드 방식인가: 이 API는 RSTR_ID 필터와 numOfRows를 무시하고 항상 1000행
// 페이지를 반환한다(실측 2026-08-21). 실시간 조회가 불가능하므로 전체 168페이지를
// 한 번 훑어 "사진이 있는 식당"(약 8천 곳)만 추려 로컬 JSON으로 굳힌다.
// 봇 런타임(Vercel·Actions)은 이 JSON만 읽으므로 토큰이 필요 없다.
//
// 데이터가 2021년 구축이라: ① 이미지 CDN 링크 생존 검사를 여기서 해두고
// ② 발행 시에는 기존 블로그 후기 수 게이트가 폐업·무명 가게를 걸러준다.
//
// 사용법: SEOUL_FOOD_TOKEN=... npx tsx scripts/build-seoul-db.mjs
//   (재실행하면 갱신 — 월 1회 정도면 충분)

import fs from "node:fs";

const TOK = process.env.SEOUL_FOOD_TOKEN;
if (!TOK) {
  console.error("SEOUL_FOOD_TOKEN 환경변수 필요");
  process.exit(1);
}
const BASE = "https://seoul.openapi.redtable.global/api";

async function page(path, pageNo) {
  for (let a = 0; a < 3; a++) {
    try {
      const r = await fetch(`${BASE}${path}?pageNo=${pageNo}&serviceKey=${TOK}`, {
        signal: AbortSignal.timeout(30000),
      });
      const j = await r.json();
      if (j?.header?.resultCode === "00") return j;
      throw new Error(j?.header?.resultMsg ?? `HTTP ${r.status}`);
    } catch (e) {
      if (a === 2) throw e;
      await new Promise((s) => setTimeout(s, 1500));
    }
  }
}

async function fetchAll(path, label) {
  const first = await page(path, 1);
  const total = Number(first.header.totalCount);
  const per = Number(first.header.numOfRows) || 1000;
  const pages = Math.ceil(total / per);
  const rows = [...(first.body ?? [])];
  for (let p = 2; p <= pages; p++) {
    const j = await page(path, p);
    rows.push(...(j.body ?? []));
    if (p % 20 === 0 || p === pages) console.log(`  ${label}: ${p}/${pages} 페이지 (${rows.length}행)`);
    await new Promise((s) => setTimeout(s, 120));
  }
  return rows;
}

console.log("① 식당 이미지 목록");
const rstrImgs = await fetchAll("/rstr/img", "rstr/img");
console.log("② 음식 이미지 목록");
const foodImgs = await fetchAll("/food/img", "food/img");

const imgsById = new Map();
for (const it of rstrImgs) {
  if (!it.RSTR_ID || !it.RSTR_IMG_URL) continue;
  const e = imgsById.get(it.RSTR_ID) ?? { imgs: [], foodImgs: [] };
  e.imgs.push(String(it.RSTR_IMG_URL));
  imgsById.set(it.RSTR_ID, e);
}
for (const it of foodImgs) {
  if (!it.RSTR_ID || !it.FOOD_IMG_URL) continue;
  const e = imgsById.get(it.RSTR_ID) ?? { imgs: [], foodImgs: [] };
  e.foodImgs.push(String(it.FOOD_IMG_URL));
  imgsById.set(it.RSTR_ID, e);
}
console.log(`이미지 보유 식당: ${imgsById.size}곳 (식당컷 ${rstrImgs.length} + 음식컷 ${foodImgs.length})`);

console.log("③ 식당 상세 (전체 페이지에서 이미지 보유분만 추림)");
const details = [];
{
  const first = await page("/rstr", 1);
  const total = Number(first.header.totalCount);
  const per = Number(first.header.numOfRows) || 1000;
  const pages = Math.ceil(total / per);
  const take = (body) => {
    for (const r of body ?? []) if (imgsById.has(r.RSTR_ID)) details.push(r);
  };
  take(first.body);
  for (let p = 2; p <= pages; p++) {
    const j = await page("/rstr", p);
    take(j.body);
    if (p % 20 === 0 || p === pages) console.log(`  rstr: ${p}/${pages} 페이지 (매칭 ${details.length}곳)`);
    await new Promise((s) => setTimeout(s, 120));
  }
}

// 업태 분포 (필터 설계용 로그)
const dist = {};
for (const d of details) dist[d.BSNS_STATM_BZCND_NM ?? "null"] = (dist[d.BSNS_STATM_BZCND_NM ?? "null"] ?? 0) + 1;
console.log("업태 분포:", JSON.stringify(dist));

// ④ 이미지 생존 검사 — 2021년 CDN이라 죽은 링크가 있을 수 있다. 동시 15개.
console.log("④ 이미지 생존 검사");
const alive = new Map();
{
  const entries = [...imgsById.entries()].filter(([id]) => details.some((d) => d.RSTR_ID === id));
  const detailIds = new Set(details.map((d) => d.RSTR_ID));
  const queue = [...imgsById.entries()].filter(([id]) => detailIds.has(id));
  let done = 0;
  const check = async (url) => {
    try {
      const r = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(10000) });
      return r.ok;
    } catch {
      return false;
    }
  };
  const workers = Array.from({ length: 15 }, async () => {
    while (queue.length) {
      const [id, e] = queue.shift();
      const liveImgs = [];
      const liveFood = [];
      for (const u of e.imgs.slice(0, 8)) if (await check(u)) liveImgs.push(u);
      for (const u of e.foodImgs.slice(0, 6)) if (await check(u)) liveFood.push(u);
      if (liveImgs.length + liveFood.length > 0) alive.set(id, { imgs: liveImgs, foodImgs: liveFood });
      done++;
      if (done % 500 === 0) console.log(`  생존 검사 ${done}곳 (생존 ${alive.size})`);
    }
  });
  await Promise.all(workers);
}
console.log(`생존 이미지 보유: ${alive.size}곳`);

const out = details
  .filter((d) => alive.has(d.RSTR_ID))
  .map((d) => {
    const e = alive.get(d.RSTR_ID);
    return {
      id: d.RSTR_ID,
      name: String(d.RSTR_NM ?? "").trim(),
      addr: String(d.RSTR_RDNMADR || d.RSTR_LNNO_ADRES || "").trim(),
      lat: d.RSTR_LA ?? null,
      lng: d.RSTR_LO ?? null,
      cat: String(d.BSNS_STATM_BZCND_NM ?? "").trim(),
      lic: String(d.BSNS_LCNC_NM ?? "").trim(),
      intro: String(d.RSTR_INTRCN_CONT ?? "").replace(/\s+/g, " ").trim().slice(0, 300),
      // 음식컷을 앞에 — 비전 선별 때 음식 사진이 먼저 검사되도록
      imgs: [...e.foodImgs, ...e.imgs].slice(0, 10),
    };
  })
  .filter((r) => r.name && r.addr && r.imgs.length >= 1);

fs.mkdirSync("data", { recursive: true });
fs.writeFileSync("data/seoul-food.json", JSON.stringify({ builtAt: new Date().toISOString(), places: out }));
const size = fs.statSync("data/seoul-food.json").size;
console.log(`✅ data/seoul-food.json — ${out.length}곳, ${(size / 1024 / 1024).toFixed(1)}MB`);
