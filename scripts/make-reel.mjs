// 릴스 자동 생성·발행 — GitHub Actions에서 실행 (ffmpeg 필요).
// 흐름: 장소 선정(인기글 우선) → 이미지 다운로드 → ffmpeg 세로 슬라이드쇼 →
//       공개 URL 업로드(Vercel Blob 또는 catbox.moe) → 릴스 API 발행 → Turso 기록.
//
// 필요한 환경변수(GitHub Secrets): TOUR_API_KEY, GEMINI_API_KEY, GEMINI_MODEL,
//   TURSO_DATABASE_URL, TURSO_AUTH_TOKEN, IG_USER_ID, IG_ACCESS_TOKEN
//   (선택) BLOB_READ_WRITE_TOKEN — 있으면 Vercel Blob, 없으면 catbox.moe 사용

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "reel-"));
const IG = "https://graph.instagram.com/v23.0";
const IGID = process.env.IG_USER_ID;

function sh(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "inherit", "inherit"] });
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exit ${code}`))));
  });
}

async function main() {
  const { db, initDb } = await import("../lib/db.ts");
  const { fetchCandidates, fetchImages, fetchOverview, MIN_IMAGES } = await import("../lib/tourapi.ts");
  const { generateCaption, buildReelCaption } = await import("../lib/caption.ts");
  const { publishReel } = await import("../lib/instagram.ts");
  await initDb();

  // 1) 대상 선정: 지난 14일 인기(좋아요+댓글×3) 1위 중 아직 릴스 안 만든 곳 우선
  let subject = null;
  const pop = await db.execute(
    `SELECT content_id, place_name, address, category, image_urls,
            (COALESCE(like_count,0)+COALESCE(comment_count,0)*3) AS score
     FROM posts
     WHERE status='published' AND category NOT IN ('주간베스트','릴스')
       AND created_at >= datetime('now','-14 days')
       AND NOT EXISTS (SELECT 1 FROM posts p2 WHERE p2.content_id = 'reel-' || posts.content_id)
     ORDER BY score DESC, id DESC LIMIT 1`
  );
  if (pop.rows.length && Number(pop.rows[0].score) > 0) {
    const r = pop.rows[0];
    let imgs = [];
    try { imgs = JSON.parse(r.image_urls || "[]"); } catch {}
    if (imgs.length >= 3) {
      subject = { contentId: String(r.content_id), name: r.place_name, address: r.address, category: r.category, imageUrls: imgs, overview: "" };
      console.log("인기글 기반 릴스:", r.place_name, `(score ${r.score})`);
    }
  }

  // 2) 인기글이 없으면 신선한 장소 선정
  if (!subject) {
    outer: for (let a = 0; a < 4; a++) {
      const cands = await fetchCandidates();
      for (const s of cands.sort(() => Math.random() - 0.5)) {
        const dup = await db.execute({ sql: "SELECT 1 FROM posts WHERE content_id IN (?, ?)", args: [s.contentId, "reel-" + s.contentId] });
        if (dup.rows.length) continue;
        const imgs = await fetchImages(s.contentId, s.imageUrl);
        if (imgs.length < MIN_IMAGES) continue;
        s.imageUrls = imgs;
        s.overview = await fetchOverview(s.contentId);
        subject = s;
        break outer;
      }
    }
  }
  if (!subject) throw new Error("릴스 대상 장소를 찾지 못함");

  // 3) 캡션: 릴스 전용 훅 (신선한 장소면 일반 캡션도 참고 가능하나 릴스는 짧게)
  const caption = buildReelCaption(subject.category);

  // 4) 이미지 다운로드 (최대 8장)
  const urls = subject.imageUrls.slice(0, 8);
  const files = [];
  for (let i = 0; i < urls.length; i++) {
    const res = await fetch(urls[i], { signal: AbortSignal.timeout(20000) });
    if (!res.ok) continue;
    const buf = Buffer.from(await res.arrayBuffer());
    const f = path.join(TMP, `img_${i}.jpg`);
    fs.writeFileSync(f, buf);
    files.push(f);
  }
  if (files.length < 3) throw new Error(`이미지 부족(${files.length}장)`);
  console.log(`이미지 ${files.length}장 다운로드`);

  // 5) ffmpeg: 각 이미지 2.6초 세로(1080x1920) 클립 → concat + 무음 오디오
  const clips = [];
  for (let i = 0; i < files.length; i++) {
    const out = path.join(TMP, `clip_${i}.mp4`);
    await sh("ffmpeg", [
      "-y", "-loop", "1", "-i", files[i], "-t", "2.6", "-r", "30",
      "-vf", "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,format=yuv420p",
      "-c:v", "libx264", "-preset", "veryfast", out,
    ]);
    clips.push(out);
  }
  const listFile = path.join(TMP, "list.txt");
  fs.writeFileSync(listFile, clips.map((c) => `file '${c}'`).join("\n"));
  const reel = path.join(TMP, "reel.mp4");
  await sh("ffmpeg", [
    "-y", "-f", "concat", "-safe", "0", "-i", listFile,
    "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-shortest", "-movflags", "+faststart", reel,
  ]);
  const size = fs.statSync(reel).size;
  console.log(`릴스 렌더 완료: ${(size / 1024 / 1024).toFixed(1)}MB`);

  // 6) 공개 URL 업로드
  const videoUrl = await uploadPublic(reel);
  console.log("업로드 URL:", videoUrl);

  // 7) 릴스 발행
  const mediaId = await publishReel(videoUrl, caption);
  console.log("✅ 릴스 발행 완료! media id:", mediaId);

  // 8) Turso 기록 (dedup용 reel-<contentId>)
  await db.execute({
    sql: `INSERT INTO posts (content_id, place_name, address, category, image_url, image_urls, caption, ig_media_id, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'published')`,
    args: [
      "reel-" + subject.contentId, subject.name, subject.address, "릴스",
      urls[0], JSON.stringify(urls), caption, mediaId,
    ],
  });
  console.log("완료:", subject.name);
}

/** Vercel Blob(토큰 있으면) 또는 catbox.moe로 공개 업로드 → URL 반환 */
async function uploadPublic(filePath) {
  const buf = fs.readFileSync(filePath);
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    const { put } = await import("@vercel/blob");
    const res = await put(`reels/${Date.now()}.mp4`, buf, {
      access: "public",
      contentType: "video/mp4",
      token: process.env.BLOB_READ_WRITE_TOKEN,
    });
    return res.url;
  }
  // 폴백: catbox.moe (무료·무계정)
  const form = new FormData();
  form.append("reqtype", "fileupload");
  form.append("fileToUpload", new Blob([buf], { type: "video/mp4" }), "reel.mp4");
  const res = await fetch("https://catbox.moe/user/api.php", { method: "POST", body: form });
  const url = (await res.text()).trim();
  if (!url.startsWith("http")) throw new Error("catbox 업로드 실패: " + url.slice(0, 200));
  return url;
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("릴스 실패:", e);
    process.exit(1);
  });
