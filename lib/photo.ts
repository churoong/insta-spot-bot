// 인스타 발행용 사진 표준화 — 원본 TourAPI 사진을 다운받아
//  ① 4:5(1080x1350) 스마트 크롭(피사체 중심)으로 규격 통일
//  ② 은은한 보정(채도·밝기·선명도 살짝)으로 먹음직스럽게
// 처리 후 공개 URL로 업로드해 반환. 실패한 사진은 원본 URL로 폴백.
//
// ⚠️ 대시보드 image_urls에는 '원본' URL을 저장할 것(업로드본은 tmpfiles 60분 만료).
//    인스타는 발행 즉시 이미지를 받아가므로 만료 전에 처리 완료됨.

import { uploadPublicImage } from "./upload";

const W = 1080;
const H = 1350; // 4:5 — 인스타 세로 캐러셀 표준

async function processOne(url: string, idx: number): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`다운로드 실패 HTTP ${res.status}`);
  const input = Buffer.from(await res.arrayBuffer());

  const sharp = (await import("sharp")).default;
  const out = await sharp(input)
    // 피사체(음식 등) 중심으로 4:5 크롭 — attention 전략이 대비·엣지가 강한 영역을 남김
    .resize(W, H, { fit: "cover", position: sharp.strategy.attention })
    // 은은한 보정: 과하지 않게(채도 +8%, 밝기 +2%) + 약한 선명도
    .modulate({ saturation: 1.08, brightness: 1.02 })
    .sharpen({ sigma: 0.7 })
    .jpeg({ quality: 88, mozjpeg: true })
    .toBuffer();

  return uploadPublicImage(out, `post-${idx}`);
}

/**
 * 사진 URL 배열을 표준화·업로드해 새 공개 URL 배열로 반환.
 * 실패한 항목은 원본 URL을 그대로 사용(발행 자체는 이어짐).
 */
export async function standardizePhotos(urls: string[]): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < urls.length; i++) {
    try {
      out.push(await processOne(urls[i], i + 1));
    } catch (e) {
      console.error(`[photo] ${i + 1}번 표준화 실패(원본 사용):`, String(e).slice(0, 120));
      out.push(urls[i]);
    }
  }
  return out;
}
