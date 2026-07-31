// 인스타 발행용 사진 표준화 — 원본 TourAPI 사진을 다운받아
//  ① 4:5(1080x1350) 스마트 크롭(피사체 중심)으로 규격 통일
//  ② 은은한 보정(채도·밝기·선명도 살짝)으로 먹음직스럽게
//  ③ 첫 사진(표지)엔 훅 텍스트 배너 합성(스크롤 정지·저장 유도)
// 처리 후 공개 URL로 업로드해 반환. 실패한 사진은 원본 URL로 폴백.
//
// ⚠️ 대시보드 image_urls에는 '원본' URL을 저장할 것(업로드본은 tmpfiles 60분 만료).
//    인스타는 발행 즉시 이미지를 받아가므로 만료 전에 처리 완료됨.

import fs from "node:fs";
import path from "node:path";
import { uploadPublicImage } from "./upload";

const W = 1080;
const H = 1350; // 4:5 — 인스타 세로 캐러셀 표준
// 서버리스(Vercel)엔 시스템 한글 폰트가 없어, 번들한 폰트 파일로 직접 렌더한다.
const FONT_PATH = path.join(process.cwd(), "assets/fonts/NanumGothic-Bold.ttf");

const escPango = (s: string) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** URL → 4:5 크롭 + 톤 프리셋 버퍼 (업로드 전) */
async function toneBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`다운로드 실패 HTTP ${res.status}`);
  const input = Buffer.from(await res.arrayBuffer());
  const sharp = (await import("sharp")).default;
  return sharp(input)
    // 피사체(음식 등) 중심으로 4:5 크롭 — attention 전략이 대비·엣지가 강한 영역을 남김
    .resize(W, H, { fit: "cover", position: sharp.strategy.attention })
    // 계정 톤 프리셋: 피드 색감 통일(은은한 따뜻·리치 톤). 필터 티 안 나게 절제.
    .modulate({ saturation: 1.1, brightness: 1.02 })
    .linear([1.05, 1.02, 0.97], [0, 0, 2])
    .sharpen({ sigma: 0.7 })
    .jpeg({ quality: 88, mozjpeg: true })
    .toBuffer();
}

/** 표지 사진에 훅 텍스트 배너 합성. 폰트 없거나 실패하면 원본 그대로(깨짐 방지). */
async function addHookBanner(photo: Buffer, hook: string): Promise<Buffer> {
  try {
    if (!fs.existsSync(FONT_PATH)) {
      console.warn("[photo] 폰트 미검출 → 표지 훅 생략:", FONT_PATH);
      return photo;
    }
    const sharp = (await import("sharp")).default;
    // 번들 폰트 파일로 텍스트 렌더(시스템 폰트 불필요)
    const text = await sharp({
      text: {
        text: `<span foreground="#ffffff" weight="bold">${escPango(hook)}</span>`,
        fontfile: FONT_PATH,
        font: "NanumGothic",
        rgba: true,
        width: 940,
        height: 96,
        align: "center",
      },
    })
      .png()
      .toBuffer();
    const tm = await sharp(text).metadata();
    const tw = tm.width ?? 900, th = tm.height ?? 90;
    const bw = Math.min(W - 60, tw + 84), bh = th + 56, by = 205;
    const bx = Math.round((W - bw) / 2);
    const banner = Buffer.from(
      `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg"><rect x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="30" fill="#000" fill-opacity="0.58"/></svg>`
    );
    return sharp(photo)
      .composite([
        { input: banner, top: 0, left: 0 },
        { input: text, top: Math.round(by + (bh - th) / 2), left: Math.round((W - tw) / 2) },
      ])
      .jpeg({ quality: 88, mozjpeg: true })
      .toBuffer();
  } catch (e) {
    console.error("[photo] 훅 합성 실패(원본 표지 사용):", String(e).slice(0, 120));
    return photo;
  }
}

/**
 * 사진 URL 배열을 표준화·업로드해 새 공개 URL 배열로 반환.
 * opts.hook 이 있으면 첫 사진(표지)에 훅 배너를 합성한다.
 * 실패한 항목은 원본 URL을 그대로 사용(발행 자체는 이어짐).
 */
export async function standardizePhotos(
  urls: string[],
  opts: { hook?: string } = {}
): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < urls.length; i++) {
    try {
      let buf = await toneBuffer(urls[i]);
      if (i === 0 && opts.hook) buf = await addHookBanner(buf, opts.hook);
      out.push(await uploadPublicImage(buf, `post-${i + 1}`));
    } catch (e) {
      console.error(`[photo] ${i + 1}번 표준화 실패(원본 사용):`, String(e).slice(0, 120));
      out.push(urls[i]);
    }
  }
  return out;
}
