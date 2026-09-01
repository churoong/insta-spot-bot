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
 * Gemini TTS로 한 문장을 음성(PCM)으로 만들어 wav 파일로 저장. 실패하면 null.
 * 무료 등급에서 동작하며, 실패해도 릴스는 무음으로 계속 발행된다.
 */
async function ttsToWav(text, outWav, voice, direction, speed = 1) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  const model = process.env.TTS_MODEL || "gemini-2.5-flash-preview-tts";
  try {
    // 스타일 지시를 앞에 붙이면 같은 목소리도 훨씬 생동감 있게 읽는다
    const prompt = direction ? `${direction}: ${text}` : text;
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice || "Kore" } } },
          },
        }),
        signal: AbortSignal.timeout(60000),
      }
    );
    const j = await res.json();
    const inline = j?.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData;
    if (!inline?.data) {
      console.error("[tts] 오디오 없음:", j?.error ? `${j.error.code} ${String(j.error.message).slice(0, 80)}` : "응답에 inlineData 없음");
      return null;
    }
    // 응답은 raw PCM(L16 24kHz mono) — ffmpeg로 wav 컨테이너에 담는다.
    // speed>1이면 atempo로 실제 말 속도를 올린다(피치는 유지돼 목소리가 변하지 않음).
    const pcm = path.join(TMP, `tts_${Date.now()}_${Math.round(Math.random() * 1e6)}.pcm`);
    fs.writeFileSync(pcm, Buffer.from(inline.data, "base64"));
    const rate = /rate=(\d+)/.exec(inline.mimeType || "")?.[1] || "24000";
    const args = ["-y", "-f", "s16le", "-ar", rate, "-ac", "1", "-i", pcm];
    const tempo = Math.min(Math.max(Number(speed) || 1, 0.5), 2); // atempo 유효 범위
    if (Math.abs(tempo - 1) > 0.01) args.push("-filter:a", `atempo=${tempo.toFixed(2)}`);
    args.push(outWav);
    await sh("ffmpeg", args);
    return outWav;
  } catch (e) {
    console.error("[tts] 실패:", String(e).slice(0, 100));
    return null;
  }
}

/** 미디어 길이(초) 조회 — ffprobe */
function mediaDuration(file) {
  return new Promise((resolve) => {
    const p = spawn("ffprobe", [
      "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file,
    ]);
    let out = "";
    p.on("error", () => resolve(0));
    p.stdout.on("data", (d) => (out += d));
    p.on("close", () => resolve(Number(String(out).trim()) || 0));
  });
}

/** 자막 바(하단)를 합성한 프레임 버퍼 — 소리를 꺼도 읽히게 */
async function withSubtitle(sharp, frameBuf, text) {
  if (!text) return frameBuf;
  // 한 줄이 너무 길면 두 줄로 나눔
  const max = 18;
  const words = String(text).split(/\s+/);
  const lines = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > max && cur) { lines.push(cur.trim()); cur = w; }
    else cur = (cur + " " + w).trim();
  }
  if (cur) lines.push(cur);
  const use = lines.slice(0, 2);
  const fontSize = 54, lineH = 74;
  const boxH = use.length * lineH + 44;
  const boxY = RH - 430 - boxH;
  const svg = Buffer.from(
    `<svg width="${RW}" height="${RH}" xmlns="http://www.w3.org/2000/svg">
      <rect x="40" y="${boxY}" width="${RW - 80}" height="${boxH}" rx="26" fill="#000" fill-opacity="0.55"/>
      ${use
        .map(
          (l, i) =>
            `<text x="${RW / 2}" y="${boxY + 34 + (i + 1) * lineH - 18}" font-family="${FONT}" font-size="${fontSize}" font-weight="800" fill="#fff" text-anchor="middle">${esc(l)}</text>`
        )
        .join("")}
    </svg>`
  );
  return sharp(frameBuf).composite([{ input: svg, top: 0, left: 0 }]).jpeg({ quality: 92 }).toBuffer();
}

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


/**
 * 디자인 카드 — 사진 없이 타이포그래피만으로 만드는 프레임.
 * 쓸 만한 음식 사진이 없을 때 사용한다(사진 퀄리티가 콘텐츠 품질을 깎지 않게).
 * 다크 그라데이션 + 계정 공통 색으로 브랜드 일관성도 얻는다.
 */
async function designCardBuffer(sharp, { badge, eyebrow, title, sub, note }) {
  const titleLines = wrapText(title, 8, 2);
  const tSize = titleLines.length >= 2 ? 116 : 132;
  const tLineH = Math.round(tSize * 1.22);
  const baseY = 760;
  const svg = Buffer.from(
    `<svg width="${RW}" height="${RH}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#17110d"/><stop offset="100%" stop-color="#3d2418"/>
        </linearGradient>
      </defs>
      <rect width="${RW}" height="${RH}" fill="url(#bg)"/>
      ${badge
        ? `<circle cx="${RW / 2}" cy="470" r="86" fill="#e23b3b"/>
           <text x="${RW / 2}" y="502" font-family="${FONT}" font-size="86" font-weight="900" fill="#fff" text-anchor="middle">${esc(badge)}</text>`
        : ""}
      ${eyebrow
        ? `<text x="${RW / 2}" y="640" font-family="${FONT}" font-size="50" font-weight="700" fill="#ffb86b" text-anchor="middle">${esc(eyebrow)}</text>`
        : ""}
      ${titleLines
        .map(
          (l, i) =>
            `<text x="${RW / 2}" y="${baseY + i * tLineH}" font-family="${FONT}" font-size="${tSize}" font-weight="900" fill="#ffffff" text-anchor="middle">${esc(l)}</text>`
        )
        .join("")}
      <rect x="${RW / 2 - 300}" y="${baseY + titleLines.length * tLineH - 30}" width="600" height="4" fill="#ffb86b"/>
      ${sub
        ? `<text x="${RW / 2}" y="${baseY + titleLines.length * tLineH + 80}" font-family="${FONT}" font-size="46" font-weight="600" fill="#e6ded8" text-anchor="middle">${esc(sub)}</text>`
        : ""}
      ${note
        ? `<text x="${RW / 2}" y="${baseY + titleLines.length * tLineH + 150}" font-family="${FONT}" font-size="44" font-weight="600" fill="#b9aca4" text-anchor="middle">${esc(note)}</text>`
        : ""}
    </svg>`
  );
  return sharp(svg).jpeg({ quality: 92 }).toBuffer();
}

/** 글자수 기준 줄바꿈 */
function wrapText(text, per, maxLines) {
  const words = String(text ?? "").split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > per && cur) { lines.push(cur.trim()); cur = w; }
    else cur = (cur + " " + w).trim();
  }
  if (cur) lines.push(cur);
  return lines.slice(0, maxLines);
}

/**
 * 텍스트 훅 카드 — 릴스 첫 화면. 사진이 아니라 '문구'가 주인공이 되게 만든다.
 * 배경은 그 가게 음식 사진을 크게 어둡히고, 큰 글씨를 중앙에 올린다.
 * (사진 퀄리티가 평범해도 첫 화면 임팩트가 유지되는 게 목적)
 */
async function composeHookCard(sharp, imgPath, hookText, subText) {
  const W = RW, H = RH;
  // ⚠️ 첫 화면은 '음식'이 바로 보여야 한다.
  //    예전엔 밝기 42% + 블러로 배경을 죽이고 글씨를 키웠는데, 맛집 계정인데
  //    첫 화면에 음식이 안 보여 0.5초 만에 스킵당했다(실측 평균 시청 1.6~3.4초).
  //    → 사진은 선명하게 두고, 글씨는 상단 배너로 얹어 음식을 가리지 않게 한다.
  const bg = await verticalFrameBuffer(sharp, imgPath); // 선명한 음식 프레임(톤 프리셋 포함)

  const text = String(hookText || "").trim();
  const words = text.split(/\s+/);
  const lines = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > 13 && cur) { lines.push(cur.trim()); cur = w; }
    else cur = (cur + " " + w).trim();
  }
  if (cur) lines.push(cur);
  const use = lines.slice(0, 2);
  const size = use.length === 2 ? 76 : 84;
  const lineH = Math.round(size * 1.26);
  const topY = 250; // 인스타 상단 UI를 피한 위치
  const boxH = use.length * lineH + 52;

  const svg = Buffer.from(
    `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
      <!-- 글자 가독성용 그라데이션(사진을 가리지 않는 상단만) -->
      <defs><linearGradient id="sh" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#000" stop-opacity="0.62"/>
        <stop offset="100%" stop-color="#000" stop-opacity="0"/>
      </linearGradient></defs>
      <rect x="0" y="0" width="${W}" height="${topY + boxH + 60}" fill="url(#sh)"/>
      ${use
        .map(
          (l, i) =>
            `<text x="${W / 2}" y="${topY + (i + 1) * lineH}" font-family="${FONT}" font-size="${size}" font-weight="900" fill="#ffffff" text-anchor="middle" stroke="#000" stroke-width="7" paint-order="stroke">${esc(l)}</text>`
        )
        .join("")}
      ${subText ? `<text x="${W / 2}" y="${topY + use.length * lineH + 62}" font-family="${FONT}" font-size="42" font-weight="700" fill="#ffd9a0" text-anchor="middle" stroke="#000" stroke-width="5" paint-order="stroke">${esc(subText)}</text>` : ""}
    </svg>`
  );
  return sharp(bg).composite([{ input: svg, top: 0, left: 0 }]).jpeg({ quality: 92 }).toBuffer();
}

/** (구) 사진 위 작은 배너형 훅 — 텍스트 카드로 대체됨 */
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
  const { publishReelSmart } = await import("../lib/instagram.ts");
  await initDb();

  // KST '오늘 1회' 가드 + 아침 발행 창(08~12시) — 이전의 20시간 롤링 간격 가드는
  // 크론 지연과 결합하면 발행 시각이 날마다 표류했다(실측 8/27~9/1: 08시→13시→22시).
  // 날짜 기준 가드는 표류하지 않고, 창 밖에 도착한 지연 런은 조용히 스킵돼
  // 다음 슬롯(또는 다음 날)이 커버한다. 하루 1개 정책은 그대로.
  // category=릴스만 세는 이유: 모음집·큐레이션까지 함께 세면 저녁 모음집이
  // 다음 날 아침 릴스를 막는다.
  const force = process.env.MIN_GAP_MIN === "0" || process.env.QUIET_HOURS_OFF === "1"; // 수동 실행용
  const today = await db.execute(
    `SELECT 1 FROM posts
     WHERE status IN ('published','publishing') AND category = '릴스'
       AND date(created_at, '+9 hours') = date('now', '+9 hours') LIMIT 1`
  );
  if (!force && today.rows.length > 0) {
    console.log("⏭️ 오늘(KST) 이미 발행됨 — 이번 회차 건너뜀");
    return;
  }
  const kstHour = (new Date().getUTCHours() + 9) % 24;
  if (!force && (kstHour < 8 || kstHour >= 12)) {
    console.log(`⏭️ 아침 발행 창(KST 08~12시) 밖 — 현재 ${kstHour}시, 건너뜀`);
    return;
  }

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
  let caption = data.caption;
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
  // 사진이 하나도 없어도 발행한다 — 디자인 카드(타이포)로 대체.
  // 사진 퀄리티가 콘텐츠 품질을 깎느니, 깔끔한 카드가 낫다.
  console.log(files.length ? `이미지 ${files.length}장 다운로드` : "사진 없음 — 디자인 카드로 구성");

  // 5) ffmpeg 세로(1080x1920) 클립 → concat + 무음 오디오.
  //    - 첫 클립: 훅 배너 합성. 사진이 1장뿐이면 그 한 장에 잔잔한 줌(5.5초).
  //      여러 장이면 훅 정지 2.4초 + 나머지 줌인 2.0초씩(모션으로 리텐션↑).
  //    - 지터 방지: 큰 크기로 업스케일 후 zoompan(서브픽셀 이동 매끄럽게)
  const sharp = (await import("sharp")).default;
  // 훅 문구: AI가 가게 사실에서 뽑은 구체적 훅 우선, 실패하면 일반 훅
  const hook = (data.hook && String(data.hook).trim()) || HOOKS[Math.floor(Math.random() * HOOKS.length)];
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

  // 나레이션 대본: 문장 수에 맞춰 컷을 구성한다(문장 1개 = 컷 1개).
  // TTS 성공한 문장은 음성 길이에 맞춰 컷 길이를 정하고 자막을 얹는다.
  const script = Array.isArray(data.narration) ? data.narration.filter(Boolean) : [];
  // 목소리·톤은 페르소나 설정(data/persona.json)을 따른다
  const persona = JSON.parse(
    fs.readFileSync(new URL("../data/persona.json", import.meta.url), "utf8")
  );
  const voice = process.env.TTS_VOICE || persona.voice || "Fenrir";
  const voiceDirection = persona.voiceDirection || "";
  const voiceSpeed = Number(process.env.TTS_SPEED || persona.voiceSpeed || 1);
  const cutCount = script.length > 0 ? script.length : files.length;
  console.log(script.length ? `나레이션 ${script.length}문장 (음성+자막)` : "나레이션 없음 — 무음 릴스");

  // ⚡ TTS는 릴스당 '한 번'만 호출한다.
  //    문장마다 따로 부르면 하루 릴스 6개 = 18회라 무료 일일 한도(429)를 금방 넘긴다.
  //    전체 대본을 한 번에 읽히고, 각 컷 길이는 문장 길이 비율로 나눠 자막과 맞춘다.
  let voiceTrack = null;
  let voiceDur = 0;
  if (script.length) {
    const full = script.join("\n");
    const w = await ttsToWav(full, path.join(TMP, "voice.wav"), voice, voiceDirection, voiceSpeed);
    if (w) {
      const d = await mediaDuration(w);
      if (d > 1) { voiceTrack = w; voiceDur = d; }
    }
    if (!voiceTrack) console.log("음성 생성 실패 — 자막만 있는 무음 릴스로 진행");
  }

  // 컷 길이: 음성이 있으면 문장 길이 비율로 나눔(자막 싱크), 없으면 기본값
  const weights = script.map((s) => Math.max(s.length, 6));
  const wsum = weights.reduce((a, b) => a + b, 0) || 1;
  const cutSecs = [];
  for (let i = 0; i < cutCount; i++) {
    // 최소 2.0초 — 너무 짧게 스치면 내용이 안 읽히고 영상도 빈약해 보인다.
    // 단 첫 컷은 3초를 넘기지 않는다(첫 장면이 길면 "정지된 광고"처럼 보여 이탈).
    if (voiceTrack) {
      const s = Math.max((voiceDur * (weights[i] ?? 1)) / wsum, 2.0);
      cutSecs.push(i === 0 ? Math.min(s, 3.0) : s);
    } else {
      cutSecs.push(i === 0 ? 2.6 : Math.round((2.4 + Math.random() * 0.6) * 10) / 10);
    }
  }
  // 마지막 컷에 여운(0.4초) — 음성이 끊기며 끝나지 않게
  if (voiceTrack) cutSecs[cutSecs.length - 1] += 0.4;

  const clips = [];
  // 첫 화면: 텍스트가 주인공인 훅 카드 (가게명·지역을 작은 부제로)
  const subText = [subject.name, (subject.address || "").split(/\s+/).slice(0, 2).join(" ")]
    .filter(Boolean)
    .join(" · ")
    .slice(0, 28);
  const region = (subject.address || "").split(/\s+/).slice(0, 2).join(" ");
  // 사진이 있으면 사진 배경 훅 카드, 없으면 디자인 카드에 훅 문구를 얹는다
  const hookImg = path.join(TMP, "hook.jpg");
  fs.writeFileSync(
    hookImg,
    files.length
      ? await composeHookCard(sharp, files[0], hook, subText)
      : await designCardBuffer(sharp, { eyebrow: region, title: hook, sub: subject.name })
  );
  // 모션 순서를 섞어 매 릴스가 같은 패턴으로 보이지 않게 함
  const order = [0, 1, 2, 3].sort(() => Math.random() - 0.5);

  for (let i = 0; i < cutCount; i++) {
    const out = path.join(TMP, `clip_${i}.mp4`);
    const line = script[i] || "";
    const secs = Math.min(cutSecs[i], 12);

    // 첫 컷은 훅 카드(자막 없이 훅 문구만), 이후는 사진 + 자막.
    // 사진 수보다 컷이 많으면 사진을 '순환'해서 쓰되(모션이 매번 달라 반복 느낌이 덜함),
    // 사진이 다 떨어진 회차에는 중간중간 정보 카드를 끼워 화면에 변화를 준다.
    let frameBuf;
    if (i === 0) {
      frameBuf = fs.readFileSync(hookImg);
    } else if (files.length) {
      const round = Math.floor((i - 1) / files.length); // 몇 바퀴째인지
      const useCard = round > 0 && (i - 1) % 2 === 1; // 두 바퀴째부터 한 컷 걸러 정보 카드
      if (useCard) {
        frameBuf = await designCardBuffer(sharp, {
          eyebrow: region,
          title: subject.name,
          sub: line,
          note: data.menu ? `대표 메뉴 · ${data.menu}` : "",
        });
      } else {
        frameBuf = await verticalFrameBuffer(sharp, files[(i - 1) % files.length]);
        frameBuf = await withSubtitle(sharp, frameBuf, line);
      }
    } else {
      // 사진 없음 — 정보 카드(상호·지역·메뉴)로 구성하고 자막은 카드에 통합
      frameBuf = await designCardBuffer(sharp, {
        eyebrow: region,
        title: subject.name,
        sub: line || data.menu || "",
      });
    }
    const frame = path.join(TMP, `frame_${i}.jpg`);
    fs.writeFileSync(frame, frameBuf);

    // 첫 컷도 정지 없이 곧바로 줌인 — 멈춰 있는 화면은 광고처럼 보여 즉시 스킵된다.
    // (0번 모션 = 줌인. 첫 화면부터 움직여야 시선이 붙는다)
    await zoomClip(frame, out, secs, i === 0 ? 0 : order[i % order.length]);
    clips.push(out);
  }

  // 영상 이어붙이기
  const listFile = path.join(TMP, "list.txt");
  fs.writeFileSync(listFile, clips.map((c) => `file '${c}'`).join("\n"));
  const silent = path.join(TMP, "silent.mp4");
  await sh("ffmpeg", [
    "-y", "-f", "concat", "-safe", "0", "-i", listFile,
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", silent,
  ]);

  // 오디오: 나레이션 + BGM 믹스. BGM은 CC BY 트랙(lib/bgm.ts)을 무한 루프로 깔고
  // 영상 끝에서 페이드아웃. 목소리가 주인공이라 BGM은 낮게(0.16), 목소리가 없으면
  // BGM이 주인공(0.35). 트랙 파일이 없으면 기존 동작(음성만/무음) 그대로.
  // 인스타 라이브러리 음악(트렌딩) 우선 — FB 로그인 경로가 설정된 경우에만 잡힌다.
  // 잡히면 CC BGM은 굽지 않는다(발행 시 audio_configuration으로 첨부, 이중 음악 방지).
  const { pickTrendingAudio } = await import("../lib/igaudio.ts");
  const igMusic = await pickTrendingAudio();
  if (igMusic) console.log("IG 라이브러리 음악:", igMusic.title ?? igMusic.id, igMusic.artist ?? "");
  const { pickBgm } = await import("../lib/bgm.ts");
  const bgm = igMusic ? null : pickBgm();
  const reel = path.join(TMP, "reel.mp4");
  const vidSec = await mediaDuration(silent);
  const fade = vidSec > 2 ? `,afade=t=out:st=${(vidSec - 0.8).toFixed(2)}:d=0.8` : "";
  if (voiceTrack && bgm) {
    await sh("ffmpeg", [
      "-y", "-i", silent, "-i", voiceTrack, "-stream_loop", "-1", "-i", bgm.path,
      "-filter_complex",
      `[1:a]apad[vo];[2:a]volume=0.16[bg];[vo][bg]amix=inputs=2:duration=longest:dropout_transition=0${fade}[a]`,
      "-map", "0:v", "-map", "[a]",
      "-c:v", "copy", "-c:a", "aac", "-b:a", "128k", "-shortest", "-movflags", "+faststart", reel,
    ]);
  } else if (voiceTrack) {
    await sh("ffmpeg", [
      "-y", "-i", silent, "-i", voiceTrack,
      "-c:v", "copy", "-c:a", "aac", "-b:a", "128k",
      "-movflags", "+faststart", reel,
    ]);
  } else if (bgm) {
    await sh("ffmpeg", [
      "-y", "-i", silent, "-stream_loop", "-1", "-i", bgm.path,
      "-filter_complex", `[1:a]volume=0.35${fade}[a]`,
      "-map", "0:v", "-map", "[a]",
      "-c:v", "copy", "-c:a", "aac", "-b:a", "128k", "-shortest", "-movflags", "+faststart", reel,
    ]);
  } else {
    await sh("ffmpeg", [
      "-y", "-i", silent,
      "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
      "-c:v", "copy", "-c:a", "aac", "-shortest", "-movflags", "+faststart", reel,
    ]);
  }
  if (bgm) {
    console.log("BGM:", bgm.title);
    caption += `
${bgm.attribution}`; // CC BY 4.0 — 저작자 표시 의무
  }
  const size = fs.statSync(reel).size;
  const totalSec = await mediaDuration(reel);
  console.log(`릴스 렌더 완료: ${(size / 1024 / 1024).toFixed(1)}MB, ${totalSec.toFixed(1)}초${voiceTrack ? " (음성 포함)" : ""}`);

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
  // 일반 릴스는 트라이얼로 발행(TRIAL_REELS=0으로 끌 수 있음) — 도달 105~140에
  // 갇혀 있던 포맷이라 비팔로워 풀에서 테스트하고 성과 통과분만 전체공개(자동)한다.
  // 모음집·큐레이션은 검증된 포맷이라 정식 발행 유지(make-roundup은 trial 미사용).
  const trial = process.env.TRIAL_REELS !== "0";
  const mediaId = await publishReelSmart(
    videoUrl,
    caption,
    igMusic ? { audioId: igMusic.id, audioVolume: voiceTrack ? 30 : 100, videoVolume: 100 } : null,
    { trial }
  );
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
