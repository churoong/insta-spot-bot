/**
 * 아침 7시 반 "오늘 점심 뭐 먹지?" 스토리(2026-10-27 사용자 결정).
 *
 * 지난 모음집 편의 1위 식당(posts.image_url = places[0].imageUrl, address 첫 줄 = 1위)을
 * 하루 한 곳 골라 1080x1920 스토리로 공식 API에 올린다. GitHub 러너에서 돌아 노트북과 무관하다.
 *  - 조회수 높은 편일수록 잘 뽑히되(√조회 가중) 최근 40회 안에 쓴 편은 건너뛴다(config morning_used).
 *  - 하루 1회 가드: config morning_story = KST 날짜.
 *  - 식당 평가는 긍정만 — 문구는 "지난 편 1위"뿐, 비교·평가 문장을 넣지 않는다.
 * 시안: MORNING_DRY=1 npx tsx --env-file=.env scripts/morning-story.mjs → morning-preview.jpg (발행 없음)
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import sharp from "sharp";

const DRY = process.env.MORNING_DRY === "1";
const W = 1080, H = 1920;
const RED = "#e02020";
const FONT = "'Pretendard','Noto Sans CJK KR','Malgun Gothic',sans-serif";
const TFONT = "'Gmarket Sans','Pretendard','Noto Sans CJK KR','Malgun Gothic',sans-serif";

const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
const kstDate = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);

async function cfg(key) {
  return (await db.execute({ sql: "SELECT value FROM config WHERE key = ?", args: [key] })).rows[0]?.value ?? null;
}
async function setCfg(key, value) {
  await db.execute({
    sql: "INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))",
    args: [key, value],
  });
}

const SIDO = {
  서울특별시: "서울", 부산광역시: "부산", 대구광역시: "대구", 인천광역시: "인천", 광주광역시: "광주",
  대전광역시: "대전", 울산광역시: "울산", 세종특별자치시: "세종", 경기도: "경기", 강원도: "강원",
  강원특별자치도: "강원", 충청북도: "충북", 충청남도: "충남", 전라북도: "전북", 전북특별자치도: "전북",
  전라남도: "전남", 경상북도: "경북", 경상남도: "경남", 제주특별자치도: "제주",
};

/** "1. 이화찹쌀순대 — 인천광역시 제물포구 …" → { name, region: "인천 제물포" } */
function firstPlace(address) {
  const m = String(address ?? "").split("\n")[0].match(/^1\.\s*(.+?)\s+—\s+(.*)$/);
  if (!m) return null;
  const [sido, sgg] = m[2].split(/\s+/);
  const s = SIDO[sido] ?? sido ?? "";
  const g = sgg && /[시군구]$/.test(sgg) && sgg.length > 2 ? sgg.slice(0, -1) : (sgg ?? "");
  return { name: m[1].trim(), region: [s, g].filter(Boolean).join(" ") };
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function fetchPhoto(url) {
  try {
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(20000) });
    if (!r.ok || !String(r.headers.get("content-type") ?? "").startsWith("image")) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    const m = await sharp(buf).metadata();
    return (m.width ?? 0) >= 500 ? buf : null; // 너무 작으면 전체 화면에서 뭉개진다
  } catch {
    return null;
  }
}

async function compose(buf, place) {
  // V2 밴드형(bandOnDark와 같은 해법) — 3:2 가로 사진을 9:16로 자르지 않고 띠로 얹는다
  const m = await sharp(buf).metadata();
  const bandH = Math.min(700, Math.max(560, Math.round(W * (m.height ?? 2) / (m.width ?? 3))));
  const bandTop = 500;
  const base = await sharp(buf).resize(W, H, { fit: "cover" }).blur(50)
    .modulate({ brightness: 0.2, saturation: 0.82 }).jpeg({ quality: 84 }).toBuffer();
  const band = await sharp(buf).resize(W, bandH, { fit: "cover", position: "attention" })
    .modulate({ saturation: 1.08 }).jpeg({ quality: 92 }).toBuffer();

  // 왼쪽 정렬은 가용 폭이 좁다 — 상호명은 가장 긴 줄 기준으로 크기를 정한다(CLAUDE.md 규칙)
  const nameSize = Math.min(110, Math.floor((W - 150) / Math.max([...place.name].length, 1)));
  const y0 = bandTop + bandH;
  const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
  <rect x="70" y="262" width="12" height="196" fill="${RED}"/>
  <text x="110" y="350" font-family="${TFONT}" font-weight="700" font-size="104" fill="#fff">오늘 점심</text>
  <text x="110" y="456" font-family="${TFONT}" font-weight="700" font-size="104" fill="${RED}">뭐 먹지?</text>
  <text x="110" y="${y0 + 92}" font-family="${FONT}" font-weight="700" font-size="44" fill="#ffd9c9">맛디깅 지난 편 1위</text>
  <text x="110" y="${y0 + 92 + Math.round(nameSize * 1.12)}" font-family="${TFONT}" font-weight="700" font-size="${nameSize}" fill="#fff">${esc(place.name)}</text>
  <text x="110" y="${y0 + 92 + Math.round(nameSize * 1.12) + 74}" font-family="${FONT}" font-weight="600" font-size="48" fill="#d8d0cc">${esc(place.region)}</text>
  <text x="110" y="${y0 + 92 + Math.round(nameSize * 1.12) + 140}" font-family="${FONT}" font-weight="600" font-size="36" fill="#9c928d">@tourist_710</text>
</svg>`;
  return sharp(base)
    .composite([{ input: band, left: 0, top: bandTop }, { input: Buffer.from(svg), left: 0, top: 0 }])
    .jpeg({ quality: 92 }).toBuffer();
}

function curlUpload(args) {
  return new Promise((resolve, reject) => {
    const p = spawn("curl", ["-s", "--max-time", "120", ...args]);
    p.on("error", reject);
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("close", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`curl exit ${code}`))));
  });
}

/** 공개 URL 업로드 폴백 체인 (Blob → tmpfiles → catbox) — make-roundup uploadPublic과 같다 */
async function uploadPublic(filePath) {
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    try {
      const { put } = await import("@vercel/blob");
      const res = await put(`morning/${Date.now()}-${path.basename(filePath)}`, fs.readFileSync(filePath), {
        access: "public", contentType: "image/jpeg", token: process.env.BLOB_READ_WRITE_TOKEN,
      });
      return res.url;
    } catch (e) {
      console.error("Vercel Blob 실패, 다음 폴백:", String(e).slice(0, 150));
    }
  }
  try {
    const out = await curlUpload(["-F", `file=@${filePath}`, "https://tmpfiles.org/api/v1/upload"]);
    const pageUrl = JSON.parse(out)?.data?.url?.replace("tmpfiles.org/", "tmpfiles.org/dl/");
    if (pageUrl) {
      const html = await fetch(pageUrl, { signal: AbortSignal.timeout(20000) }).then((r) => r.text());
      const m = html.match(/href="(https:\/\/tmpfiles\.org\/dl\/[^"]+\.(?:jpg|jpeg|png))"/);
      if (m) return m[1];
    }
  } catch (e) {
    console.error("tmpfiles 실패, 다음 폴백:", String(e).slice(0, 150));
  }
  const out = await curlUpload([
    "-F", "reqtype=fileupload", "-F", "userhash=", "-F", `fileToUpload=@${filePath}`,
    "https://catbox.moe/user/api.php",
  ]);
  if (out.startsWith("http")) return out;
  throw new Error("모든 업로드 실패: " + out.slice(0, 200));
}

async function main() {
  const today = kstDate();
  if (!DRY && (await cfg("morning_story")) === today) {
    console.log(`오늘(${today}) 아침 스토리는 이미 올렸다 — 스킵`);
    return;
  }
  let used = [];
  try { used = JSON.parse((await cfg("morning_used")) || "[]"); } catch { /* 처음 */ }

  const rows = (await db.execute(`SELECT content_id, address, image_url, views FROM posts
    WHERE status = 'published' AND content_id LIKE 'roundup-%' AND image_url IS NOT NULL AND address LIKE '1. %'
    ORDER BY views DESC LIMIT 80`)).rows.filter((r) => !used.includes(String(r.content_id)));
  if (!rows.length) throw new Error("고를 지난 편이 없다");

  // √조회 가중 무작위 순서 — 상위 몇 편만 반복되지 않게
  const order = rows.map((r) => ({ r, k: Math.random() ** (1 / Math.sqrt(Math.max(Number(r.views) || 1, 1))) }))
    .sort((a, b) => b.k - a.k).map((x) => x.r);

  for (const r of order) {
    const place = firstPlace(r.address);
    if (!place) continue;
    const buf = await fetchPhoto(String(r.image_url));
    if (!buf) {
      console.log("사진 실패, 다음 후보:", place.name);
      continue;
    }
    const out = DRY ? path.resolve("morning-preview.jpg") : path.join(os.tmpdir(), `morning-${Date.now()}.jpg`);
    fs.writeFileSync(out, await compose(buf, place));
    console.log(`🌅 ${place.name} (${place.region}) — ${r.content_id}, 조회 ${r.views}`);
    if (DRY) {
      console.log("DRY — 발행하지 않음:", out);
      return;
    }
    const { publishStory } = await import("../lib/instagram.ts");
    const id = await publishStory(await uploadPublic(out));
    await setCfg("morning_story", today);
    await setCfg("morning_used", JSON.stringify([String(r.content_id), ...used].slice(0, 40)));
    console.log("📣 아침 스토리 발행:", id);
    return;
  }
  throw new Error("쓸 수 있는 사진이 있는 후보가 없다");
}

main().then(() => process.exit(0)).catch((e) => {
  console.error("아침 스토리 실패:", e);
  process.exit(1);
});
