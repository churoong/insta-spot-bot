// "어제의 그곳, 정답 공개" 스토리 자동 발행 — GitHub Actions에서 매일 실행.
// 퀴즈 게시물(상호명 비공개)의 정답을 다음날 스토리로 공개해 참여 루프를 완성한다.
// 스토리는 24시간 뒤 사라지므로 피드의 퀴즈 재미는 유지됨.
//
// 필요한 환경변수: TURSO_DATABASE_URL, TURSO_AUTH_TOKEN, IG_USER_ID, IG_ACCESS_TOKEN
//   (선택) BLOB_READ_WRITE_TOKEN, STORY_DRY=1(발행 없이 이미지 파일만)

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "story-"));
const DRY = process.env.STORY_DRY === "1";
const HANDLE = process.env.IG_USERNAME || "tourist_710";
const FONT = "'Noto Sans CJK KR','NanumGothic','Malgun Gothic',sans-serif";
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function main() {
  const { db, initDb } = await import("../lib/db.ts");
  const { publishStory } = await import("../lib/instagram.ts");
  await initDb();

  // 발행 쿨다운(행동차단 회복) 중이면 스토리도 쉼
  const cd = await db.execute("SELECT value FROM config WHERE key='publish_cooldown_until'");
  if (cd.rows.length > 0) {
    const until = new Date(String(cd.rows[0].value).replace(" ", "T") + "Z").getTime();
    if (Date.now() < until && !DRY) {
      console.log("발행 쿨다운 중 — 스토리 건너뜀");
      return;
    }
  }

  // 20시간 이상 지난 미공개 퀴즈 게시물 중 반응 1위
  const r = await db.execute(
    `SELECT id, place_name, address, category, image_url, image_urls, like_count, comment_count
     FROM posts
     WHERE status='published' AND category IN ('맛집','여행지')
       AND COALESCE(revealed,0)=0 AND ig_media_id IS NOT NULL
       AND datetime(created_at) <= datetime('now','-20 hours')
     ORDER BY (COALESCE(like_count,0)+COALESCE(comment_count,0)*3) DESC, id DESC LIMIT 1`
  );
  if (r.rows.length === 0) {
    console.log("공개할 퀴즈 게시물 없음");
    return;
  }
  const p = r.rows[0];
  let imgs = [];
  try { imgs = JSON.parse(String(p.image_urls || "[]")); } catch {}
  const photoUrl = imgs[0] || String(p.image_url);
  console.log("정답 공개 대상:", p.place_name);

  // 세로(1080x1920) 스토리 이미지 합성
  const sharp = (await import("sharp")).default;
  const W = 1080, H = 1920;
  const res = await fetch(photoUrl, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error("사진 다운로드 실패 " + res.status);
  const photo = await sharp(Buffer.from(await res.arrayBuffer()))
    .resize(W, H, { fit: "cover" })
    .jpeg({ quality: 85 })
    .toBuffer();

  const region = String(p.address || "").split(/\s+/).slice(0, 2).join(" ");
  const nm = String(p.place_name);
  const ns = nm.length <= 8 ? 72 : nm.length <= 12 ? 56 : 44;
  const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <rect x="0" y="0" width="${W}" height="230" fill="#000000" fill-opacity="0.55"/>
    <text x="${W / 2}" y="105" font-family="${FONT}" font-size="46" font-weight="800" fill="#ffd9d9" text-anchor="middle">어제 다들 궁금해하셨던 그곳</text>
    <text x="${W / 2}" y="180" font-family="${FONT}" font-size="58" font-weight="900" fill="#ffffff" text-anchor="middle">정답 공개!</text>
    <rect x="0" y="${H - 330}" width="${W}" height="330" fill="#000000" fill-opacity="0.62"/>
    <text x="${W / 2}" y="${H - 240}" font-family="${FONT}" font-size="${ns}" font-weight="900" fill="#ffffff" text-anchor="middle">${esc(nm)}</text>
    <text x="${W / 2}" y="${H - 165}" font-family="${FONT}" font-size="34" font-weight="600" fill="#e5d8d8" text-anchor="middle">${esc(region)} · ${esc(String(p.category))}</text>
    <text x="${W / 2}" y="${H - 80}" font-family="${FONT}" font-size="30" fill="#c9b8b8" text-anchor="middle">다음 퀴즈도 기대해 주세요 · @${HANDLE}</text>
  </svg>`;
  const out = path.join(TMP, "story.jpg");
  await sharp(photo).composite([{ input: Buffer.from(svg), left: 0, top: 0 }]).jpeg({ quality: 87 }).toFile(out);
  console.log("스토리 이미지 합성 완료");

  if (DRY) {
    fs.copyFileSync(out, "story-preview.jpg");
    console.log("DRY 모드 — story-preview.jpg 저장, 발행 생략");
    return;
  }

  const url = await uploadPublic(out);
  console.log("업로드:", url);
  const storyId = await publishStory(url);
  console.log("✅ 정답 공개 스토리 발행:", storyId);

  await db.execute({ sql: "UPDATE posts SET revealed = 1 WHERE id = ?", args: [p.id] });
  console.log("완료:", p.place_name);
}

function curlUpload(args) {
  return new Promise((resolve, reject) => {
    const p = spawn("curl", ["-s", "--max-time", "120", ...args]);
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("close", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`curl exit ${code}`))));
  });
}

async function uploadPublic(filePath) {
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    try {
      const { put } = await import("@vercel/blob");
      const res = await put(`stories/${Date.now()}.jpg`, fs.readFileSync(filePath), {
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
      const m = html.match(/href="(https:\/\/tmpfiles\.org\/dl\/[^"]+\.(?:jpg|jpeg|png|mp4))"/);
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

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("스토리 실패:", e);
    process.exit(1);
  });
