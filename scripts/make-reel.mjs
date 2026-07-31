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
const FONT = "'Noto Sans CJK KR','NanumGothic','Malgun Gothic',sans-serif";

// 첫 1~2초에 노출되는 훅 문구 — 이탈 방지·끝까지 보기 유도(도달 핵심). 이모지는 SVG에서
// 깨질 수 있어 이미지엔 넣지 않음(이모지는 캡션에서만).
const HOOKS = [
  "저장 안 하면 후회해요", "현지인만 아는 그 맛", "왜 다들 여기 줄 설까?",
  "이건 무조건 저장각", "숨은 맛집 찾았어요", "이 맛, 꼭 저장하세요",
  "끝까지 보면 저장각", "아는 사람만 가는 곳",
];
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** 첫 프레임에 훅 배너를 합성한 세로 이미지 버퍼 반환 */
async function composeHook(sharp, imgPath, hook) {
  const W = 1080, H = 1920;
  const base = await sharp(imgPath)
    .resize(W, H, { fit: "cover", position: sharp.strategy.attention })
    .modulate({ saturation: 1.08, brightness: 1.02 })
    .toBuffer();
  const svg = Buffer.from(
    `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
      <rect x="45" y="235" width="990" height="160" rx="30" fill="#000" fill-opacity="0.60"/>
      <text x="${W / 2}" y="340" font-family="${FONT}" font-size="60" font-weight="900" fill="#fff" text-anchor="middle">${esc(hook)}</text>
    </svg>`
  );
  return sharp(base).composite([{ input: svg, top: 0, left: 0 }]).jpeg({ quality: 90 }).toBuffer();
}

function sh(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "inherit", "inherit"] });
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exit ${code}`))));
  });
}

async function main() {
  const { db, initDb } = await import("../lib/db.ts");
  const { fetchCandidates, fetchQuizImages, fetchOverview, MIN_IMAGES } = await import("../lib/tourapi.ts");
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
        const imgs = await fetchQuizImages(s.contentId, s.imageUrl, s.category);
        if (imgs.length < MIN_IMAGES) continue;
        s.imageUrls = imgs;
        s.overview = await fetchOverview(s.contentId);
        subject = s;
        break outer;
      }
    }
  }
  if (!subject) throw new Error("릴스 대상 장소를 찾지 못함");

  // 3) 캡션: 릴스 전용 훅 + 지역 해시태그 (본문 위치 비공개)
  const caption = buildReelCaption(subject.category, subject.address);

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

  // 5) ffmpeg 세로(1080x1920) 클립 → concat + 무음 오디오.
  //    - 첫 클립: 훅 배너 합성 + 정지 2.4초(문구 안정적으로 읽히게)
  //    - 이후 클립: 잔잔한 줌인 2.0초(정지 슬라이드쇼는 이탈률↑ → 모션으로 리텐션↑)
  //      지터 방지: 큰 크기로 업스케일 후 zoompan(서브픽셀 이동 매끄럽게)
  const sharp = (await import("sharp")).default;
  const hook = HOOKS[Math.floor(Math.random() * HOOKS.length)];
  console.log("훅:", hook);
  const clips = [];
  for (let i = 0; i < files.length; i++) {
    const out = path.join(TMP, `clip_${i}.mp4`);
    if (i === 0) {
      const hookImg = path.join(TMP, "hook.jpg");
      fs.writeFileSync(hookImg, await composeHook(sharp, files[0], hook));
      await sh("ffmpeg", [
        "-y", "-loop", "1", "-i", hookImg, "-t", "2.4", "-r", "30",
        "-vf", "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,format=yuv420p",
        "-c:v", "libx264", "-preset", "veryfast", out,
      ]);
    } else {
      await sh("ffmpeg", [
        "-y", "-loop", "1", "-i", files[i], "-t", "2.0", "-r", "30",
        "-vf",
        "scale=3240:5760:flags=lanczos,zoompan=z='min(zoom+0.0008,1.15)':d=60:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1080x1920:fps=30,format=yuv420p",
        "-c:v", "libx264", "-preset", "veryfast", out,
      ]);
    }
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

/** curl로 파일 업로드하고 stdout 반환 (Actions 러너에 curl 내장) */
function curlUpload(args) {
  return new Promise((resolve, reject) => {
    const p = spawn("curl", ["-s", "--max-time", "120", ...args]);
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("close", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`curl exit ${code}`))));
  });
}

/**
 * 공개 URL 업로드 (폴백 체인).
 * 1) Vercel Blob (BLOB_READ_WRITE_TOKEN 있으면 — 가장 안정)
 * 2) tmpfiles.org (무료·무계정, 60분 보관 — 인스타가 가져가기엔 충분)
 * 3) catbox.moe (무료·무계정)
 */
async function uploadPublic(filePath) {
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    try {
      const { put } = await import("@vercel/blob");
      const res = await put(`reels/${Date.now()}.mp4`, fs.readFileSync(filePath), {
        access: "public",
        contentType: "video/mp4",
        token: process.env.BLOB_READ_WRITE_TOKEN,
      });
      return res.url;
    } catch (e) {
      console.error("Vercel Blob 실패, 다음 폴백:", String(e).slice(0, 150));
    }
  }

  // tmpfiles.org — 응답: {"status":"success","data":{"url":"https://tmpfiles.org/ID/f.mp4"}}
  // /dl/ 페이지 HTML 안의 서명된 직접 다운로드 링크를 추출해야 raw 파일이 나옴.
  try {
    const out = await curlUpload(["-F", `file=@${filePath}`, "https://tmpfiles.org/api/v1/upload"]);
    const pageUrl = JSON.parse(out)?.data?.url?.replace("tmpfiles.org/", "tmpfiles.org/dl/");
    if (pageUrl) {
      const html = await fetch(pageUrl, { signal: AbortSignal.timeout(20000) }).then((r) => r.text());
      const m = html.match(/href="(https:\/\/tmpfiles\.org\/dl\/[^"]+\.mp4)"/);
      if (m) return m[1];
      console.error("tmpfiles 서명 링크 못 찾음");
    } else {
      console.error("tmpfiles 응답 이상:", out.slice(0, 150));
    }
  } catch (e) {
    console.error("tmpfiles 실패, 다음 폴백:", String(e).slice(0, 150));
  }

  // catbox.moe
  const out = await curlUpload([
    "-F", "reqtype=fileupload",
    "-F", "userhash=",
    "-F", `fileToUpload=@${filePath}`,
    "https://catbox.moe/user/api.php",
  ]);
  if (out.startsWith("http")) return out;
  throw new Error("모든 업로드 실패. catbox 응답: " + out.slice(0, 200));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("릴스 실패:", e);
    process.exit(1);
  });
