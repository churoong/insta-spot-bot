// 자료 수집 에이전트(2026-11-25 사용자 결정 — "카페도 추가하자, 일단 자료를 수집할 수 있는 에이전트").
//   npx tsx --env-file=.env scripts/collect.mjs            # 전체 수집 종류
//   COLLECT=cafe npx tsx --env-file=.env scripts/collect.mjs
//
// 발행은 하지 않는다 — 나중에 새 콘텐츠(카페 편 등)가 쓸 재료를 data/collect/<종류>.json에 쌓는다.
// 사진은 관광공사 공공누리 1·3유형(상업 이용 가능)만, 남의 블로그·인스타 사진은 쓰지 않는다(절대 규칙).
// 관광공사 API 하루 한도는 발행과 공유 — collect.yml이 새벽(KST 00~05시)에만, 7일에 한 번 돈다.
import fs from "node:fs";
import path from "node:path";

const OUT_DIR = "data/collect";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 수집 종류 — 새 종류는 여기 한 줄 추가. cat3은 관광공사 분류(음식점 39 하위).
const KINDS = [
  { key: "cafe", label: "카페·전통찻집", contentTypeId: "39", cat1: "A05", cat2: "A0502", cat3: "A05020900", buzzWord: "카페", exclude: /주점|호프|포차|바\b|클럽|노래/ },
];
const AREAS = [
  [1, "서울"], [2, "인천"], [3, "대전"], [4, "대구"], [5, "광주"], [6, "부산"], [7, "울산"], [8, "세종"],
  [31, "경기"], [32, "강원"], [33, "충북"], [34, "충남"], [35, "경북"], [36, "경남"], [37, "전북"], [38, "전남"], [39, "제주"],
];

let quotaHit = false;
async function tour(endpoint, params) {
  const base = (process.env.APP_BASE_URL || "https://insta-spot-bot.vercel.app").replace(/\/$/, "");
  // GitHub 러너 IP는 data.go.kr이 막는다 — CRON_SECRET이 있으면 Vercel 프록시로(make-roundup·build-series와 같은 경로)
  if (process.env.CRON_SECRET) {
    const pq = new URLSearchParams({ endpoint, ...params });
    try {
      const r = await fetch(`${base}/api/tour-proxy?${pq}`, { headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` }, signal: AbortSignal.timeout(40000) });
      const j = await r.json();
      if (!Array.isArray(j.items)) { if (/LIMITED|요청제한/.test(JSON.stringify(j))) quotaHit = true; return []; }
      return j.items;
    } catch { return []; }
  }
  const qs = new URLSearchParams({ serviceKey: process.env.TOUR_API_KEY || "", MobileOS: "ETC", MobileApp: "spot", _type: "json", ...params });
  try {
    const j = await (await fetch(`https://apis.data.go.kr/B551011/KorService2/${endpoint}?${qs}`, { signal: AbortSignal.timeout(20000) })).json();
    if (/LIMITED|요청제한/.test(JSON.stringify(j).slice(0, 400))) quotaHit = true;
    const it = j?.response?.body?.items?.item ?? [];
    return Array.isArray(it) ? it : [it];
  } catch { return []; }
}

async function collectKind(kind) {
  const rows = [];
  for (const [areaCode, sido] of AREAS) {
    const items = await tour("areaBasedList2", {
      contentTypeId: kind.contentTypeId, areaCode: String(areaCode),
      cat1: kind.cat1, cat2: kind.cat2, cat3: kind.cat3, numOfRows: "1000", arrange: "Q",
    });
    const ok = items.filter((x) => x.firstimage && (x.cpyrhtDivCd === "Type1" || x.cpyrhtDivCd === "Type3") && !kind.exclude?.test(x.title || ""));
    console.log(`  ${sido}: ${items.length}곳 중 사진·이용 가능 ${ok.length}곳`);
    for (const x of ok) {
      rows.push({
        contentId: String(x.contentid), name: String(x.title).trim(), sido,
        addr: String(x.addr1 || "").trim(), x: Number(x.mapx) || null, y: Number(x.mapy) || null,
        img: x.firstimage, img2: x.firstimage2 || null, license: x.cpyrhtDivCd,
        modified: String(x.modifiedtime || "").slice(0, 8),
      });
    }
    if (quotaHit) break;
    await sleep(300);
  }
  return rows;
}

// 인기도 — 네이버 블로그 후기 수(랭킹 lib/ranking.ts와 같은 신호). 키가 없으면 건너뛴다.
// 검색어 v4(2026-11-25) = v2 방식 "시군구 상호 카페"로 되돌림. v3(상호 따옴표)는 네이버 블로그 API가 따옴표를
// 무시해 v1과 같은 값(오던 92만)이 나왔다. 흔한 이름으로 튀는 값은 아래 verifyAndFlag가 걸러 낸다.
const BUZZ_V = 4;
function sigunguOf(r) {
  const t = String(r.addr || "").split(/\s+/);
  return t[1] || t[0] || r.sido || "";
}
function cafeQuery(r, kind) {
  const clean = String(r.name).replace(/\[[^\]]*\]/g, "").replace(/"/g, "").trim();
  return `${sigunguOf(r)} ${clean} ${kind.buzzWord || ""}`.trim();
}

// 실제 가게 확인(네이버 지역 검색) + 튀는 후기 수 표시 — 2026-11-25 사용자 결정.
//   verified: 지역 검색에 같은 상호·같은 시군구가 나오면 true, 못 찾으면 false(키 없음·실패는 null)
//   buzzSuspect: 후기 수가 BUZZ_CAP 이상이거나 같은 시도 중앙값의 30배 이상 — 이름이 흔해 엉뚱한 글이 섞인 것으로 본다
//   rankScore: 정렬용(확인된 집 > 미확인, 튀는 값은 시도 중앙값으로 대체)
const BUZZ_CAP = 100000;
const normName = (s) => String(s).replace(/<[^>]*>/g, "").replace(/\[[^\]]*\]|\s|\(.*?\)/g, "").toLowerCase();
async function verifyAndFlag(rows, prev) {
  const { searchLocal } = await import("../lib/naver.ts");
  const old = new Map((prev?.items || []).map((r) => [r.contentId, r]));
  let n = 0;
  for (const r of rows) {
    const o = old.get(r.contentId);
    if (o?.verified != null && o.verifiedAt && Date.now() - new Date(o.verifiedAt).getTime() < 30 * 86400e3) { r.verified = o.verified; r.verifiedAt = o.verifiedAt; continue; }
    if (n >= 1500) continue;
    const sg = sigunguOf(r);
    const res = await searchLocal(`${sg} ${String(r.name).replace(/\[[^\]]*\]/g, "").trim()}`, 5);
    n++;
    if (res) {
      const nm = normName(r.name);
      r.verified = res.some((p) => {
        const pn = normName(p.name);
        return (pn.includes(nm) || nm.includes(pn)) && `${p.address} ${p.roadAddress}`.includes(sg.replace(/(시|군|구)$/, ""));
      });
      r.verifiedAt = new Date().toISOString().slice(0, 10);
    } else r.verified = null;
    await sleep(120);
  }
  const bySido = {};
  for (const r of rows) if (r.buzz != null) (bySido[r.sido] ??= []).push(r.buzz);
  const med = Object.fromEntries(Object.entries(bySido).map(([k, v]) => [k, v.sort((a, b) => a - b)[Math.floor(v.length / 2)] || 0]));
  for (const r of rows) {
    const m = med[r.sido] || 0;
    r.buzzSuspect = r.buzz != null && (r.buzz >= BUZZ_CAP || (m > 0 && r.buzz >= m * 30));
    const base = r.buzzSuspect ? m : r.buzz ?? 0;
    r.rankScore = (r.verified === false ? 0.2 : 1) * base;
  }
  return n;
}

async function addBuzz(rows, prev, kind) {
  const { blogBuzz } = await import("../lib/naver.ts");
  const old = new Map((prev?.items || []).map((r) => [r.contentId, r]));
  let n = 0;
  for (const r of rows) {
    const o = old.get(r.contentId);
    // 30일 안에 같은 검색어 버전으로 잰 값은 재사용(네이버 하루 한도 아끼기)
    if (o?.buzz != null && o.buzzV === BUZZ_V && o.buzzAt && Date.now() - new Date(o.buzzAt).getTime() < 30 * 86400e3) { r.buzz = o.buzz; r.buzzAt = o.buzzAt; r.buzzV = BUZZ_V; continue; }
    if (n >= 1500) continue;
    const b = await blogBuzz(cafeQuery(r, kind));
    n++;
    if (b != null) { r.buzz = b; r.buzzAt = new Date().toISOString().slice(0, 10); r.buzzV = BUZZ_V; }
    await sleep(120);
  }
  return n;
}

const MARK = path.join(OUT_DIR, "_built.json");
fs.mkdirSync(OUT_DIR, { recursive: true });
const mark = fs.existsSync(MARK) ? JSON.parse(fs.readFileSync(MARK, "utf8")) : {};
const only = process.env.COLLECT;
for (const kind of KINDS.filter((k) => !only || k.key === only)) {
  if (!process.env.FORCE && mark[kind.key] && Date.now() - new Date(mark[kind.key]).getTime() < 7 * 86400e3) {
    console.log(`${kind.label}: 7일 안에 수집함(${mark[kind.key]}) — 건너뜀`);
    continue;
  }
  console.log(`▶ ${kind.label} 수집`);
  const file = path.join(OUT_DIR, `${kind.key}.json`);
  const prev = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
  const rows = await collectKind(kind);
  if (quotaHit || rows.length < 20) {
    console.log(`⚠️ ${kind.label}: ${quotaHit ? "관광공사 한도 초과" : `결과가 ${rows.length}곳뿐`} — 기존 파일 유지`);
    continue;
  }
  const measured = await addBuzz(rows, prev, kind).catch((e) => { console.log("블로그 후기 수 실패(무시):", String(e).slice(0, 80)); return 0; });
  const checked = await verifyAndFlag(rows, prev).catch((e) => { console.log("실제 가게 확인 실패(무시):", String(e).slice(0, 80)); return 0; });
  rows.sort((a, b) => (b.rankScore ?? b.buzz ?? -1) - (a.rankScore ?? a.buzz ?? -1));
  const suspect = rows.filter((r) => r.buzzSuspect).length, unverified = rows.filter((r) => r.verified === false).length;
  console.log(`   실제 가게 확인 새로 ${checked}곳 · 지도에서 못 찾음 ${unverified}곳 · 튀는 후기 수 ${suspect}곳(${rows.filter((r) => r.buzzSuspect).slice(0, 6).map((r) => r.name).join(", ")})`);
  const bySido = {};
  for (const r of rows) bySido[r.sido] = (bySido[r.sido] || 0) + 1;
  fs.writeFileSync(file, JSON.stringify({ kind: kind.key, label: kind.label, collectedAt: new Date().toISOString(), count: rows.length, bySido, items: rows }, null, 1));
  mark[kind.key] = new Date().toISOString();
  console.log(`✅ ${kind.label} ${rows.length}곳 저장(${file}) · 후기 수 새로 잰 곳 ${measured} · 시도별 ${JSON.stringify(bySido)}`);
  console.log(`   순위 상위: ${rows.slice(0, 10).map((r) => `${r.name}(${r.sido} ${r.buzz ?? "?"}${r.verified === false ? " 미확인" : ""})`).join(" · ")}`);
}
fs.writeFileSync(MARK, JSON.stringify(mark, null, 1));
