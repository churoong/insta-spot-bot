// 성과 기반 발굴 — 지금까지 발행한 맛집 게시물의 반응(좋아요·댓글)을 음식 종류별로
// 집계해, 반응이 좋은 음식을 더 자주 발굴하도록 키워드 선택에 가중치를 준다.
//
// 콜드스타트/소규모 계정 대비: 데이터가 없거나 적으면 사실상 균등 랜덤(탐험),
// 잘 되는 음식이 쌓이면 그쪽 비중이 서서히 커짐(활용). 과적합 방지를 위해
// 모든 키워드에 기본 가중치 1을 깔고 성과분을 더한다.

import { db } from "./db";
import { FOOD_KEYWORDS } from "./tourapi";

/** 게시물명에서 음식 키워드 추정 (이름에 그 음식명이 들어간 경우) */
function keywordOf(placeName: string): string | null {
  for (const kw of FOOD_KEYWORDS) if (placeName.includes(kw)) return kw;
  return null;
}

/**
 * 반응 데이터로 가중한 음식 키워드 1개 반환.
 * 점수 = 좋아요 + 3×댓글. 키워드별 평균점수를 가중치(1 + avg)로 사용.
 * 데이터가 없으면 균등 랜덤과 동일하게 동작.
 */
export async function pickPerformingKeyword(): Promise<string> {
  const stat: Record<string, { sum: number; n: number }> = {};
  try {
    const rows = (
      await db.execute(
        "SELECT place_name, like_count, comment_count FROM posts WHERE status='published' AND category='맛집'"
      )
    ).rows as any[];
    for (const r of rows) {
      const kw = keywordOf(String(r.place_name ?? ""));
      if (!kw) continue;
      const score = (Number(r.like_count) || 0) + (Number(r.comment_count) || 0) * 3;
      (stat[kw] ??= { sum: 0, n: 0 }).sum += score;
      stat[kw].n += 1;
    }
  } catch {
    /* 반응 데이터 조회 실패 시 균등 랜덤으로 폴백 */
  }

  // 가중치: 기본 1(탐험) + 평균 성과(활용)
  const weights = FOOD_KEYWORDS.map((kw) => {
    const s = stat[kw];
    const avg = s && s.n ? s.sum / s.n : 0;
    return 1 + avg;
  });

  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < FOOD_KEYWORDS.length; i++) {
    r -= weights[i];
    if (r <= 0) return FOOD_KEYWORDS[i];
  }
  return FOOD_KEYWORDS[FOOD_KEYWORDS.length - 1];
}
