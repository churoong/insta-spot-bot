/**
 * "대한민국 국밥 국경선" 지도 릴스(2026-10-27 사용자 결정).
 *
 * 시군구마다 국밥 다섯 종류(돼지국밥·순대국·해장국·콩나물국밥·소머리국밥) 가게 수를 카카오 로컬로 세고,
 * 전국 평균보다 유난히 많은 국밥(특화 지수)으로 지도를 칠해 8초 릴스로 올린다. 사진이 필요 없어
 * 관광공사 사진 한계와 무관하다. 식당 평가가 없는 데이터 콘텐츠 — 지역 우열 표현도 쓰지 않는다.
 *
 * 집계: 시군구 경계 상자(rect)로 키워드 검색(음식점 FD6) → 받은 가게 중 경계 안에 든 비율 × total_count.
 *   경계는 data/geo/sigungu-2013.json(통계청). 결과는 data/border-gukbap.json에 캐시, 30일 지나면 다시 센다.
 * 실행:
 *   BORDER_OFFLINE=1 npx tsx scripts/make-border.mjs   → 착한가격업소 데이터로 지도만 렌더(border-preview.jpg, 시크릿 불필요)
 *   BORDER_DRY=1 npx tsx --env-file=.env scripts/make-border.mjs  → 카카오 집계 + 렌더, 발행 없음
 *   npx tsx --env-file=.env scripts/make-border.mjs    → 발행(릴스 + 표지 스토리 + 해시태그 첫 댓글 + 스레드)
 *   BORDER_REBUILD=1 → 캐시가 있어도 다시 센다
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const OFFLINE = process.env.BORDER_OFFLINE === "1";
const DRY = OFFLINE || process.env.BORDER_DRY === "1";
const REBUILD = process.env.BORDER_REBUILD === "1";
const KAKAO = process.env.KAKAO_REST_KEY;
const CACHE = "data/border-gukbap.json";
const W = 1080, H = 1920;
const RED = "#e02020";
const BG = "#f6f1e7";
const FONT = "'Pretendard','Noto Sans CJK KR',sans-serif";
const TFONT = "'Gmarket Sans','Pretendard','Noto Sans CJK KR',sans-serif";

const TYPES = [
  { key: "돼지국밥", queries: ["돼지국밥"], re: /돼지\s?(수육)?국밥/, color: "#e02020" },
  { key: "순대국", queries: ["순대국", "순댓국"], re: /순대\s?국|순댓국/, color: "#2f5da8" },
  { key: "해장국", queries: ["해장국"], re: /해장국/, color: "#e9a23b" },
  { key: "콩나물국밥", queries: ["콩나물국밥"], re: /콩나물/, color: "#4e9a5a" },
  { key: "소머리국밥", queries: ["소머리국밥"], re: /소머리/, color: "#7a4e3a" },
];
const SIDO_SHORT = {
  11: "서울", 21: "부산", 22: "대구", 23: "인천", 24: "광주", 25: "대전", 26: "울산", 29: "세종", 31: "경기",
  32: "강원", 33: "충북", 34: "충남", 35: "전북", 36: "전남", 37: "경북", 38: "경남", 39: "제주",
};

const muni = JSON.parse(fs.readFileSync("data/geo/sigungu-2013.json", "utf8")).features;
const prov = JSON.parse(fs.readFileSync("data/geo/sido-2013.json", "utf8")).features;
const kstDate = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ---------- 경계 계산 ----------
const polys = (g) => (g.type === "MultiPolygon" ? g.coordinates : [g.coordinates]);
function bbox(g) {
  let x1 = 180, y1 = 90, x2 = -180, y2 = -90;
  for (const p of polys(g)) for (const [x, y] of p[0]) {
    x1 = Math.min(x1, x); x2 = Math.max(x2, x); y1 = Math.min(y1, y); y2 = Math.max(y2, y);
  }
  return [x1, y1, x2, y2];
}
function inRing(x, y, ring) {
  let ins = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) ins = !ins;
  }
  return ins;
}
const inGeom = (x, y, g) => polys(g).some((p) => inRing(x, y, p[0]) && !p.slice(1).some((h) => inRing(x, y, h)));
function findFeature(x, y) {
  for (const f of muni) {
    const [x1, y1, x2, y2] = f._bbox ??= bbox(f.geometry);
    if (x >= x1 && x <= x2 && y >= y1 && y <= y2 && inGeom(x, y, f.geometry)) return f;
  }
  return null;
}

// ---------- 집계 ----------
async function kakaoKeyword(params) {
  const qs = new URLSearchParams({ category_group_code: "FD6", size: "15", ...params });
  for (let i = 0; i < 4; i++) {
    const r = await fetch(`https://dapi.kakao.com/v2/local/search/keyword.json?${qs}`, {
      headers: { Authorization: `KakaoAK ${KAKAO}` }, signal: AbortSignal.timeout(15000),
    }).catch(() => null);
    if (r?.ok) return r.json();
    await sleep(1500 * (i + 1));
  }
  throw new Error("카카오 검색 실패: " + qs.get("query"));
}

/**
 * 시군구 하나 × 국밥 하나의 가게 수. 카카오 키워드 검색은 느슨하게 맞춰("순대국" → 국밥집 전반)
 * total_count가 실제 가게 수가 아니다(2026-10-27 첫 집계에서 부산 돼지국밥 22% < 순대국 43%로 나와 폐기).
 * 그래서 상호명·카테고리에 그 국밥 이름이 실제로 들어간 가게만 세고, 검색 상한(45개)에 걸리면
 * 상자를 4등분해 다시 센다. 결과는 정확도순이라 마지막 페이지에 맞는 가게가 하나도 없으면 더 쪼개지 않는다.
 */
async function countIn(f, t) {
  const hit = new Set();
  async function walk(x1, y1, x2, y2, depth) {
    for (const q of t.queries) {
      let lastHits = 0, end = false;
      for (let page = 1; page <= 3 && !end; page++) {
        const j = await kakaoKeyword({ query: q, rect: `${x1},${y1},${x2},${y2}`, page: String(page) });
        end = j.meta?.is_end ?? true;
        lastHits = 0;
        for (const d of j.documents ?? []) {
          if (!t.re.test(`${d.place_name} ${d.category_name}`)) continue;
          lastHits++;
          if (inGeom(Number(d.x), Number(d.y), f.geometry)) hit.add(d.id);
        }
        await sleep(60);
      }
      if (!end && lastHits > 0 && depth < 5) {
        const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
        for (const [a, b, c, d] of [[x1, y1, mx, my], [mx, y1, x2, my], [x1, my, mx, y2], [mx, my, x2, y2]]) {
          if (bboxHits(f, a, b, c, d)) await walk(a, b, c, d, depth + 1);
        }
        return; // 쪼갠 쪽이 이 질의를 다시 센다(다른 표기 질의도 쪼갠 칸에서)
      }
    }
  }
  const [x1, y1, x2, y2] = f._bbox ??= bbox(f.geometry);
  await walk(x1, y1, x2, y2, 0);
  return hit.size;
}

/** 쪼갠 칸이 시군구 상자와 겹치는지 — 경계 밖 칸은 건너뛴다(대충, 상자끼리만) */
function bboxHits(f, a, b, c, d) {
  const [x1, y1, x2, y2] = f._bbox ??= bbox(f.geometry);
  return a < x2 && c > x1 && b < y2 && d > y1;
}

async function buildKakao() {
  const out = {};
  let n = 0;
  for (const f of muni) {
    const c = {};
    for (const t of TYPES) c[t.key] = await countIn(f, t);
    out[f.properties.code] = c;
    if (++n % 25 === 0) console.log(`  집계 ${n}/${muni.length}`);
  }
  return out;
}

/** 오프라인 시안 — 착한가격업소(주소 시도·시군구 이름)로 대충 센다. 표본이 얇아 실제 발행엔 쓰지 않는다. */
function buildOffline() {
  const shops = JSON.parse(fs.readFileSync("data/goodprice.json", "utf8")).shops;
  const sidoCode = (s) => Object.entries(SIDO_SHORT).find(([, v]) =>
    s.startsWith(v) || s.startsWith({ 충북: "충청북", 충남: "충청남", 전북: "전라북", 전남: "전라남", 경북: "경상북", 경남: "경상남" }[v] ?? "\0"))?.[0];
  const out = {};
  for (const s of shops) {
    const t = TYPES.find((t) => t.re.test(`${s.n} ${s.m}`));
    if (!t) continue;
    const sc = sidoCode(s.sd), sg = String(s.sg).replace(/\s/g, "");
    const f = muni.find((f) => f.properties.code.startsWith(sc) && (f.properties.name === sg || f.properties.name.startsWith(sg)));
    if (!f) continue;
    (out[f.properties.code] ??= Object.fromEntries(TYPES.map((t) => [t.key, 0])))[t.key]++;
  }
  return out;
}

async function loadCounts() {
  if (OFFLINE) return { source: "goodprice", counts: buildOffline() };
  if (!REBUILD && fs.existsSync(CACHE)) {
    const c = JSON.parse(fs.readFileSync(CACHE, "utf8"));
    if (Date.now() - Date.parse(c.builtAt) < 30 * 86400e3) {
      console.log("집계 캐시 사용:", c.builtAt);
      return c;
    }
  }
  if (!KAKAO) throw new Error("KAKAO_REST_KEY 없음 — 집계 불가(시안은 BORDER_OFFLINE=1)");
  console.log(`카카오 집계 시작: 시군구 ${muni.length} × 국밥 ${TYPES.length}`);
  const c = { builtAt: new Date().toISOString(), source: "kakao", counts: await buildKakao() };
  const total = Object.values(c.counts).reduce((a, v) => a + Object.values(v).reduce((x, y) => x + y, 0), 0);
  if (total < 300) throw new Error(`집계가 너무 적다(${total}) — 카카오 응답 이상, 캐시하지 않음`);
  fs.writeFileSync(CACHE, JSON.stringify(c));
  return c;
}

// ---------- 특화 지수 ----------
/** 전국 비율 대비 이 지역 비율(평활) 최댓값의 국밥. 가게가 너무 적으면 null(회색). */
function makeWinner(national) {
  const N = Object.values(national).reduce((a, b) => a + b, 0) || 1;
  const share = Object.fromEntries(TYPES.map((t) => [t.key, (national[t.key] || 0) / N]));
  return (c, minTotal) => {
    const n = Object.values(c ?? {}).reduce((a, b) => a + b, 0);
    if (n < minTotal) return null;
    const K = 6; // 작은 표본이 지수 1위를 독식하지 않게 전국 비율 쪽으로 당긴다
    const lq = TYPES.map((t) => [t.key, ((c[t.key] || 0) + K * share[t.key]) / (n + K) / (share[t.key] || 1e-9)]);
    lq.sort((a, b) => b[1] - a[1]);
    return lq[0][1] - (lq[1]?.[1] ?? 0) < 0.02 ? null : lq[0][0];
  };
}

// ---------- 렌더 ----------
const LON0 = 124.55, LON1 = 131.0, LAT0 = 33.05, LAT1 = 38.65;
const KX = Math.cos((36 * Math.PI) / 180);
const SCALE = Math.min(980 / ((LON1 - LON0) * KX), 1080 / (LAT1 - LAT0));
const OX = (W - (LON1 - LON0) * KX * SCALE) / 2, OY = 470;
const proj = ([lon, lat]) => [OX + (lon - LON0) * KX * SCALE, OY + (LAT1 - lat) * SCALE];
const pathOf = (g) => polys(g).map((p) => p.map((r) => "M" + r.map((pt) => proj(pt).map((v) => v.toFixed(1)).join(",")).join("L") + "Z").join("")).join("");

function mix(hex, a) {
  const n = (i) => parseInt(hex.slice(i, i + 2), 16), b = [0xf6, 0xf1, 0xe7];
  return "#" + [n(1), n(3), n(5)].map((v, i) => Math.round(v + (b[i] - v) * a).toString(16).padStart(2, "0")).join("");
}
function centerOf(g) {
  // 가장 큰 고리의 상자 중심 — 섬이 많은 시도(전남·경남)에서 바다 위로 가지 않게
  let best = null, area = -1;
  for (const p of polys(g)) {
    const [x1, y1, x2, y2] = bbox({ type: "Polygon", coordinates: p });
    if ((x2 - x1) * (y2 - y1) > area) { area = (x2 - x1) * (y2 - y1); best = [(x1 + x2) / 2, (y1 + y2) / 2]; }
  }
  return proj(best);
}

function renderSvg(muniWin, sidoWin, total, source) {
  const color = Object.fromEntries(TYPES.map((t) => [t.key, t.color]));
  const fills = muni.map((f) => {
    const w = muniWin[f.properties.code];
    const pw = sidoWin[f.properties.code.slice(0, 2)];
    const fill = w ? color[w] : pw ? mix(color[pw], 0.62) : "#e4ddd0";
    return `<path d="${pathOf(f.geometry)}" fill="${fill}" stroke="#fff" stroke-width="0.8" fill-rule="evenodd"/>`;
  }).join("");
  const borders = prov.map((f) => `<path d="${pathOf(f.geometry)}" fill="none" stroke="#28221e" stroke-width="2.2" stroke-linejoin="round"/>`).join("");

  // 라벨: 시군구를 가장 많이 차지한 국밥 2개 → 그 국밥이 가장 넓게 칠한 시도 중심에 "○○ 나라"
  const wins = {};
  for (const [code, w] of Object.entries(muniWin)) if (w) (wins[w] ??= []).push(code);
  const labels = [];
  for (const [k, codes] of Object.entries(wins).sort((a, b) => b[1].length - a[1].length).slice(0, 2)) {
    if (codes.length < 6) continue;
    // 시군구 개수가 아니라 면적으로 — 작은 구가 25개인 서울이 늘 이기지 않게
    const bySido = {};
    for (const c of codes) {
      const [x1, y1, x2, y2] = bbox(muni.find((f) => f.properties.code === c).geometry);
      bySido[c.slice(0, 2)] = (bySido[c.slice(0, 2)] || 0) + (x2 - x1) * (y2 - y1);
    }
    const sc = Object.entries(bySido).sort((a, b) => b[1] - a[1]).map(([s]) => s)
      .find((s) => !labels.some((l) => l.sc === s));
    const pf = prov.find((f) => f.properties.code === sc);
    if (!pf) continue;
    let [x, y] = centerOf(pf.geometry);
    if (labels.some((l) => Math.abs(l.y - y) < 70)) y += 80;
    labels.push({ sc, x, y, text: `${k} 나라`, color: color[k] });
  }
  const labelSvg = labels.map((l) => {
    const w = [...l.text].length * 33 + 40;
    const x = Math.max(40 + w / 2, Math.min(W - 40 - w / 2, l.x));
    return `<rect x="${x - w / 2}" y="${l.y - 30}" width="${w}" height="60" rx="14" fill="${l.color}"/>
<text x="${x}" y="${l.y + 12}" text-anchor="middle" font-family="${TFONT}" font-weight="700" font-size="34" fill="#fff">${esc(l.text)}</text>`;
  }).join("");

  // 범례 — 두 줄까지 자동 줄바꿈
  let lx = 80, ly = 1600;
  const legend = TYPES.map((t) => {
    const w = 46 + [...t.key].length * 34 + 40;
    if (lx + w > W - 60) { lx = 80; ly += 60; }
    const s = `<rect x="${lx}" y="${ly}" width="34" height="34" rx="8" fill="${t.color}"/>
<text x="${lx + 46}" y="${ly + 29}" font-family="${FONT}" font-weight="700" font-size="34" fill="#222">${t.key}</text>`;
    lx += w;
    return s;
  }).join("");
  const note = source === "kakao"
    ? `카카오맵 상호에 국밥 이름이 든 가게 ${total.toLocaleString("ko-KR")}곳 · 전국 평균보다 유난히 많은 국밥`
    : `시안 · 착한가격업소 국밥집 ${total}곳 기준`;

  return `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
<rect width="${W}" height="${H}" fill="${BG}"/>
${fills}${borders}${labelSvg}
<text x="80" y="210" font-family="${TFONT}" font-weight="700" font-size="64" fill="#111">대한민국</text>
<text x="80" y="335" font-family="${TFONT}" font-weight="700" font-size="118" fill="${RED}">국밥 국경선</text>
<text x="84" y="415" font-family="${FONT}" font-weight="700" font-size="44" fill="#222">우리 동네는 무슨 국밥파?</text>
${legend}
<text x="80" y="1790" font-family="${FONT}" font-size="26" fill="#777">${esc(note)}</text>
<text x="80" y="1834" font-family="${FONT}" font-weight="600" font-size="28" fill="#999">@tourist_710</text>
</svg>`;
}

// ---------- 발행 ----------
function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("error", reject);
    p.on("close", (c) => (c === 0 ? resolve(out.trim()) : reject(new Error(`${cmd} exit ${c}`))));
  });
}

/** 공개 URL 업로드 폴백 체인 (Blob → tmpfiles → catbox) — make-roundup uploadPublic과 같다 */
async function uploadPublic(filePath, contentType) {
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    try {
      const { put } = await import("@vercel/blob");
      const res = await put(`border/${Date.now()}-${path.basename(filePath)}`, fs.readFileSync(filePath), {
        access: "public", contentType, token: process.env.BLOB_READ_WRITE_TOKEN,
      });
      return res.url;
    } catch (e) {
      console.error("Vercel Blob 실패, 다음 폴백:", String(e).slice(0, 150));
    }
  }
  try {
    const out = await run("curl", ["-s", "--max-time", "120", "-F", `file=@${filePath}`, "https://tmpfiles.org/api/v1/upload"]);
    const u = JSON.parse(out)?.data?.url;
    if (u) return u.replace("tmpfiles.org/", "tmpfiles.org/dl/");
  } catch (e) {
    console.error("tmpfiles 실패, 다음 폴백:", String(e).slice(0, 150));
  }
  const out = await run("curl", ["-s", "--max-time", "120", "-F", "reqtype=fileupload", "-F", "userhash=",
    "-F", `fileToUpload=@${filePath}`, "https://catbox.moe/user/api.php"]);
  if (out.startsWith("http")) return out;
  throw new Error("모든 업로드 실패: " + out.slice(0, 200));
}

function buildCaption(sidoWin, bgm) {
  const lines = Object.entries(SIDO_SHORT)
    .filter(([c]) => sidoWin[c])
    .map(([c, s]) => `${s} · ${sidoWin[c]}`);
  return [
    "대한민국 국밥 국경선 🗺",
    "우리 동네는 무슨 국밥파?",
    "",
    ...lines,
    "",
    "여러분 동네는 어느 국밥 쪽이에요? 댓글로 알려주세요 🍲",
    "📤 국밥 친구에게 보내서 서로 동네 국밥 확인해 보기",
    "",
    "#국밥 #국밥맛집 #돼지국밥 #순대국 #전국맛집",
    ...(bgm ? ["", bgm.attribution] : []),
  ].join("\n");
}

async function main() {
  const data = await loadCounts();
  const counts = data.counts;
  const national = {}, bySido = {};
  for (const [code, c] of Object.entries(counts)) {
    for (const [k, v] of Object.entries(c)) {
      national[k] = (national[k] || 0) + v;
      (bySido[code.slice(0, 2)] ??= {})[k] = (bySido[code.slice(0, 2)][k] || 0) + v;
    }
  }
  const total = Object.values(national).reduce((a, b) => a + b, 0);
  const winner = makeWinner(national);
  const muniWin = Object.fromEntries(muni.map((f) => [f.properties.code, winner(counts[f.properties.code], data.source === "kakao" ? 8 : 2)]));
  const sidoWin = Object.fromEntries(Object.entries(bySido).map(([s, c]) => [s, winner(c, 3)]));
  console.log("전국:", national, "합계", total);
  console.log("시도 1위:", Object.entries(sidoWin).map(([s, w]) => `${SIDO_SHORT[s]}=${w}`).join(" "));

  const svg = renderSvg(muniWin, sidoWin, total, data.source);
  const jpg = "border-preview.jpg";
  await sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toFile(jpg);
  console.log("지도 렌더:", jpg);

  const { pickBgm } = await import("../lib/bgm.ts");
  const bgm = pickBgm();
  const caption = buildCaption(sidoWin, bgm);
  fs.writeFileSync("border-caption.txt", caption);
  if (DRY) {
    console.log("--- 캡션 ---\n" + caption);
    return;
  }

  const { createClient } = await import("@libsql/client");
  const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
  const cid = `border-gukbap-${kstDate()}`;
  const dup = await db.execute({ sql: "SELECT 1 FROM posts WHERE content_id = ? AND status IN ('published','publishing')", args: [cid] });
  if (dup.rows.length) return console.log("오늘 이미 발행 — 스킵:", cid);
  await db.execute({ sql: "DELETE FROM posts WHERE content_id = ? AND status = 'failed'", args: [cid] });
  await db.execute({
    sql: `INSERT INTO posts (content_id, place_name, address, category, image_url, caption, status, reel_format)
          VALUES (?, '대한민국 국밥 국경선', ?, '지도', NULL, ?, 'publishing', 'map8')`,
    args: [cid, Object.entries(sidoWin).map(([s, w]) => `${SIDO_SHORT[s]} ${w ?? "-"}`).join("\n"), caption],
  });
  try {
    // 표지 8초 단일컷 — 모음집 grid8과 같은 구성(모션 없음). "-t"는 출력 옵션(입력 위치면 BGM 루프와 엉킨다)
    const mp4 = "border-reel.mp4";
    await run("ffmpeg", [
      "-y", "-loop", "1", "-i", jpg,
      ...(bgm ? ["-stream_loop", "-1", "-i", bgm.path] : ["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100"]),
      "-filter_complex", `[0:v]fps=30,format=yuv420p[v]${bgm ? ";[1:a]volume=0.35,afade=t=out:st=7.2:d=0.8[a]" : ""}`,
      "-map", "[v]", "-map", bgm ? "[a]" : "1:a",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-tune", "stillimage", "-c:a", "aac",
      "-t", "8", "-movflags", "+faststart", mp4,
    ]);
    const videoUrl = await uploadPublic(mp4, "video/mp4");
    const { publishReelSmart, commentOnMedia, publishStory } = await import("../lib/instagram.ts");
    const mediaId = await publishReelSmart(videoUrl, caption, null);
    await db.execute({ sql: "UPDATE posts SET ig_media_id = ?, status = 'published' WHERE content_id = ?", args: [mediaId, cid] });
    console.log("✅ 국밥 국경선 릴스 발행:", mediaId);
    try {
      const tags = "#국밥지도 #해장국 #콩나물국밥 #소머리국밥 #국밥러버";
      console.log("💬 첫 댓글(해시태그):", await commentOnMedia(mediaId, tags));
    } catch (e) {
      console.error("첫 댓글 실패(무시):", String(e).slice(0, 150));
    }
    try {
      console.log("📣 표지 스토리 공유:", await publishStory(await uploadPublic(jpg, "image/jpeg")));
    } catch (e) {
      console.error("스토리 실패(무시):", String(e).slice(0, 150));
    }
    try {
      const { publishThreads } = await import("../lib/threads.ts");
      const text = `대한민국 국밥 국경선\n\n${Object.entries(SIDO_SHORT).filter(([c]) => sidoWin[c]).map(([c, s]) => `${s} · ${sidoWin[c]}`).join("\n")}\n\n여러분 동네는 어느 국밥 쪽이에요?\n지도는 인스타 @tourist_710`;
      const id = await publishThreads({ text, videoUrl, topicTag: "국밥맛집" });
      if (id) {
        await db.execute({ sql: "UPDATE posts SET threads_id = ? WHERE content_id = ?", args: [id, cid] });
        console.log("🧵 스레드 동시 발행:", id);
      }
    } catch (e) {
      console.error("스레드 발행 실패(무시):", String(e).slice(0, 200));
    }
  } catch (e) {
    await db.execute({ sql: "UPDATE posts SET status = 'failed' WHERE content_id = ? AND status = 'publishing'", args: [cid] });
    throw e;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
