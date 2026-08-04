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

const RW = 1080, RH = 1920; // 릴스 규격 9:16

/**
 * 원본 사진 → 왜곡 없는 1080x1920 세로 프레임 버퍼.
 *  - 세로·정사각에 가까우면 음식 중심 스마트 크롭으로 꽉 채움
 *  - 가로로 긴 사진은 꽉 채우면 위아래가 심하게 잘리므로, 흐린 배경 위에
 *    원본 비율 그대로 얹는다 (늘어남·찌그러짐 없음)
 * 계정 톤 프리셋도 함께 적용해 피드와 색감을 통일한다.
 */
async function verticalFrameBuffer(sharp, imgPath) {
  const meta = await sharp(imgPath).metadata();
  const ar = (meta.width || 1) / (meta.height || 1);
  const tone = (p) =>
    p.modulate({ saturation: 1.1, brightness: 1.02 }).linear([1.05, 1.02, 0.97], [0, 0, 2]).sharpen({ sigma: 0.7 });

  if (ar <= 1.5) {
    // 꽉 채워도 피사체가 살아있는 비율 — 스마트 크롭(왜곡 없음)
    return tone(sharp(imgPath).resize(RW, RH, { fit: "cover", position: sharp.strategy.attention }))
      .jpeg({ quality: 92 })
      .toBuffer();
  }
  // 가로로 긴 사진 — 흐린 배경 + 비율 유지 배치
  const bg = await sharp(imgPath).resize(RW, RH, { fit: "cover" }).blur(30).modulate({ brightness: 0.78 }).toBuffer();
  const fg = await tone(sharp(imgPath).resize(RW, null, { fit: "inside" })).toBuffer();
  const fm = await sharp(fg).metadata();
  return sharp(bg)
    .composite([{ input: fg, top: Math.round((RH - (fm.height || RH)) / 2), left: 0 }])
    .jpeg({ quality: 92 })
    .toBuffer();
}

/** 왜곡 없는 세로 프레임을 파일로 저장 */
async function toVerticalFrame(sharp, inFile, outFile) {
  const fs2 = await import("node:fs");
  fs2.default.writeFileSync(outFile, await verticalFrameBuffer(sharp, inFile));
}

/** 첫 프레임에 훅 배너를 합성한 세로 이미지 버퍼 반환 */
async function composeHook(sharp, imgPath, hook) {
  const W = RW, H = RH;
  const base = await verticalFrameBuffer(sharp, imgPath); // 왜곡 없는 세로 프레임 재사용
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
    p.on("error", reject); // spawn 자체 실패(ENOENT 등) — 없으면 Promise가 영원히 안 끝남
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exit ${code}`))));
  });
}

async function main() {
  const { db, initDb } = await import("../lib/db.ts");
  const { publishReel } = await import("../lib/instagram.ts");
  await initDb();

  // 대상 선정은 Vercel의 /api/reel-candidate 가 담당한다.
  // ⚠️ data.go.kr(TourAPI)이 GitHub Actions 러너 IP를 간헐적으로 차단해(2026-08 실측)
  //    Actions에서 직접 수집하면 발행이 통째로 멈춘다. Vercel에서는 정상 접근되므로
  //    데이터 수집·캡션 생성은 Vercel, 영상 렌더·발행은 Actions로 역할을 분리.
  const base = (process.env.APP_BASE_URL || "https://insta-spot-bot.vercel.app").replace(/\/$/, "");
  let data = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(`${base}/api/reel-candidate`, {
        headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
        signal: AbortSignal.timeout(290000),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(`후보 API HTTP ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
      if (j.skipped) { console.log("⏭️ 스킵:", j.reason); return; }
      data = j;
      break;
    } catch (e) {
      console.error(`후보 API 실패(시도 ${attempt + 1}/3):`, String(e).slice(0, 150));
      if (attempt < 2) await new Promise((r) => setTimeout(r, 5000));
    }
  }
  if (!data) throw new Error("릴스 후보를 받지 못함 (Vercel 후보 API 응답 없음)");

  const subject = {
    contentId: data.contentId,
    name: data.name,
    address: data.address,
    category: data.category,
    imageUrls: data.imageUrls, // 프록시 URL(다운로드용)
    mapx: data.mapx,
    mapy: data.mapy,
    mapUrl: data.mapUrl,
  };
  const originalUrls = data.originalUrls || data.imageUrls; // DB 기록용
  const caption = data.caption;
  console.log("릴스 대상:", subject.name, `(사진 ${subject.imageUrls.length}장)`);

  // 4) 이미지 다운로드 (최대 8장)
  const urls = subject.imageUrls.slice(0, 8);
  const files = [];
  for (let i = 0; i < urls.length; i++) {
    try {
      const res = await fetch(urls[i], { signal: AbortSignal.timeout(20000) });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      const f = path.join(TMP, `img_${i}.jpg`);
      fs.writeFileSync(f, buf);
      files.push(f);
    } catch (e) {
      // 한 장 실패로 릴스 전체를 중단하지 않음 (네트워크·타임아웃)
      console.error(`이미지 ${i} 다운로드 실패(건너뜀):`, String(e).slice(0, 80));
    }
  }
  if (files.length < 1) throw new Error("음식 이미지 없음");
  console.log(`이미지 ${files.length}장 다운로드`);

  // 5) ffmpeg 세로(1080x1920) 클립 → concat + 무음 오디오.
  //    - 첫 클립: 훅 배너 합성. 사진이 1장뿐이면 그 한 장에 잔잔한 줌(5.5초).
  //      여러 장이면 훅 정지 2.4초 + 나머지 줌인 2.0초씩(모션으로 리텐션↑).
  //    - 지터 방지: 큰 크기로 업스케일 후 zoompan(서브픽셀 이동 매끄럽게)
  const sharp = (await import("sharp")).default;
  const hook = HOOKS[Math.floor(Math.random() * HOOKS.length)];
  console.log("훅:", hook);
  const single = files.length === 1;

  // ⚠️ 사진을 ffmpeg에서 9:16으로 강제 스케일하면 가로 사진(대부분의 음식 사진)이
  //    위아래로 쭉 늘어나 왜곡된다. 반드시 sharp로 '왜곡 없는' 세로 프레임을 먼저
  //    만든 뒤 ffmpeg는 줌·팬만 주게 한다.
  //
  // 켄번즈 모션 4종을 번갈아 써서 "같은 줌만 반복"하는 기계적인 느낌을 줄인다.
  // (입력이 이미 1080x1920이므로 3배 업스케일은 비율 그대로 — 지터 방지 목적)
  const MOTIONS = [
    (d) => `zoompan=z='min(zoom+0.0006,1.14)':d=${d}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`, // 줌인
    (d) => `zoompan=z='if(lte(on,1),1.14,max(zoom-0.0006,1.0))':d=${d}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`, // 줌아웃
    (d) => `zoompan=z='min(zoom+0.0005,1.12)':d=${d}:x='(iw-iw/zoom)*on/${d}':y='ih/2-(ih/zoom/2)'`, // 줌인+좌→우
    (d) => `zoompan=z='min(zoom+0.0005,1.12)':d=${d}:x='iw/2-(iw/zoom/2)':y='(ih-ih/zoom)*on/${d}'`, // 줌인+위→아래
  ];
  const zoomClip = async (inFile, out, secs, motionIdx = 0) => {
    const d = Math.round(secs * 30);
    const vf = `scale=3240:5760:flags=lanczos,${MOTIONS[motionIdx % MOTIONS.length](d)}:s=1080x1920:fps=30,format=yuv420p`;
    try {
      await sh("ffmpeg", [
        "-y", "-loop", "1", "-i", inFile, "-t", String(secs), "-r", "30",
        "-vf", vf, "-c:v", "libx264", "-preset", "veryfast", out,
      ]);
    } catch (e) {
      // 모션 표현식 문제 시에도 발행이 죽지 않게 정지 컷으로 폴백
      console.error("모션 렌더 실패 → 정지 컷 사용:", String(e).slice(0, 100));
      await sh("ffmpeg", [
        "-y", "-loop", "1", "-i", inFile, "-t", String(secs), "-r", "30",
        "-vf", "scale=1080:1920,format=yuv420p", "-c:v", "libx264", "-preset", "veryfast", out,
      ]);
    }
  };

  const clips = [];
  const hookImg = path.join(TMP, "hook.jpg");
  fs.writeFileSync(hookImg, await composeHook(sharp, files[0], hook));
  // 모션 순서를 섞어 매 릴스가 같은 패턴으로 보이지 않게 함
  const order = [0, 1, 2, 3].sort(() => Math.random() - 0.5);
  for (let i = 0; i < files.length; i++) {
    const out = path.join(TMP, `clip_${i}.mp4`);
    if (i === 0 && single) {
      // 한 장뿐: 훅 얹은 사진(이미 1080x1920)을 잔잔히 줌
      await zoomClip(hookImg, out, 5.5, order[0]);
    } else if (i === 0) {
      // 훅 정지 컷 (문구 안정적으로 읽히게)
      await sh("ffmpeg", [
        "-y", "-loop", "1", "-i", hookImg, "-t", "2.4", "-r", "30",
        "-vf", "scale=1080:1920,format=yuv420p", // 이미 9:16이라 비율 변화 없음
        "-c:v", "libx264", "-preset", "veryfast", out,
      ]);
    } else {
      const frame = path.join(TMP, `frame_${i}.jpg`);
      await toVerticalFrame(sharp, files[i], frame); // 왜곡 없는 세로 프레임
      // 길이도 살짝 다르게(1.8~2.3초) — 일정 간격 컷은 기계적으로 보임
      const secs = Math.round((1.8 + Math.random() * 0.5) * 10) / 10;
      await zoomClip(frame, out, secs, order[i % order.length]);
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

  // 7) 중복발행 방지: 발행 '전에' dedup 마커 기록. DM용 위치정보(mapx/mapy/map_url)도 저장
  //    (웹훅 '어디야' → place_name/address/map_url로 DM 발송).
  //    이미지는 '원본' URL로 저장(대시보드 갤러리는 프록시 아닌 원본을 씀).
  const cid = "reel-" + subject.contentId;
  await db.execute({
    sql: `INSERT INTO posts (content_id, place_name, address, category, image_url, image_urls, caption, status, mapx, mapy, map_url)
          VALUES (?, ?, ?, '릴스', ?, ?, ?, 'publishing', ?, ?, ?)`,
    args: [
      cid, subject.name, subject.address, originalUrls[0], JSON.stringify(originalUrls), caption,
      subject.mapx ?? null, subject.mapy ?? null, subject.mapUrl ?? null,
    ],
  });

  // 8) 릴스 발행 → 성공 시 완료 상태로 갱신
  const mediaId = await publishReel(videoUrl, caption);
  console.log("✅ 릴스 발행 완료! media id:", mediaId);
  await db.execute({
    sql: `UPDATE posts SET ig_media_id = ?, status = 'published' WHERE content_id = ?`,
    args: [mediaId, cid],
  });
  console.log("완료:", subject.name);
}

/** curl로 파일 업로드하고 stdout 반환 (Actions 러너에 curl 내장) */
function curlUpload(args) {
  return new Promise((resolve, reject) => {
    const p = spawn("curl", ["-s", "--max-time", "120", ...args]);
    p.on("error", reject); // spawn 실패 시 Promise가 안 끝나는 것 방지
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
