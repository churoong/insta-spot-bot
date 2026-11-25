// 무료 스톡 음식 영상(2026-11-25 사용자 결정) — 모음집 릴스 첫 2초 분위기 컷용.
// Pexels(PEXELS_KEY) → Pixabay(PIXABAY_KEY) 순. 둘 다 무료·상업 이용 가능·출처 표기 의무 없음.
// ⚠️ 특정 가게 영상이 아니다 — '그 음식'의 분위기 컷으로만 쓰고, 어느 식당 영상인 것처럼 보이게 하지 않는다
// (lib/pexels.ts와 같은 원칙: 사칭 방지). 키가 없거나 못 찾으면 null → 호출부는 기존 표지 8초로.

export interface StockClip {
  url: string;
  source: "pexels" | "pixabay";
  id: string;
  credit: string;
  portrait: boolean;
}

// 음식 → 영어 검색어(스톡 사이트는 영어 태그가 대부분). 없으면 "korean food".
const QUERY: [RegExp, string][] = [
  [/국밥|해장국|순대국|곰탕|설렁탕|감자탕|추어탕|어탕|삼계탕|백숙|부대찌개|순두부|매운탕/, "korean soup"],
  [/냉면|막국수|밀면/, "cold noodles"],
  [/짬뽕/, "spicy noodle soup"],
  [/칼국수|국수|우동|고기국수/, "noodle soup"],
  [/갈비|삼겹살|고기|곱창|닭갈비|흑돼지|족발|보쌈/, "korean bbq"],
  [/회|초밥|물회/, "sashimi"],
  [/떡볶이/, "tteokbokki"],
  [/김밥/, "kimbap"],
  [/만두/, "dumplings"],
  [/카페/, "latte coffee"],
];

export function stockQuery(food: string): string {
  for (const [re, q] of QUERY) if (re.test(food)) return q;
  return "korean food";
}

async function pexels(query: string): Promise<StockClip | null> {
  const key = process.env.PEXELS_KEY;
  if (!key) return null;
  try {
    const qs = new URLSearchParams({ query, orientation: "portrait", per_page: "20", size: "medium" });
    const r = await fetch(`https://api.pexels.com/videos/search?${qs}`, { headers: { Authorization: key }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) return null;
    const vids: any[] = (await r.json())?.videos ?? [];
    const pool = vids.filter((v) => Number(v.duration) >= 3).sort(() => Math.random() - 0.5);
    for (const v of pool) {
      const files: any[] = (v.video_files ?? []).filter((f: any) => f.link && f.height >= 1280 && f.width <= 1440 && /mp4/.test(f.file_type ?? "video/mp4"));
      files.sort((a, b) => Math.abs(a.width - 1080) - Math.abs(b.width - 1080));
      if (files[0]) return { url: files[0].link, source: "pexels", id: String(v.id), credit: `Pexels · ${v.user?.name ?? ""}`.trim(), portrait: files[0].height > files[0].width };
    }
  } catch { /* 다음 소스 */ }
  return null;
}

async function pixabay(query: string): Promise<StockClip | null> {
  const key = process.env.PIXABAY_KEY;
  if (!key) return null;
  try {
    const qs = new URLSearchParams({ key, q: query, per_page: "30", safesearch: "true" });
    const r = await fetch(`https://pixabay.com/api/videos/?${qs}`, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) return null;
    const hits: any[] = ((await r.json())?.hits ?? []).filter((h: any) => Number(h.duration) >= 3).sort(() => Math.random() - 0.5);
    for (const h of hits) {
      const f = h.videos?.large?.url ? h.videos.large : h.videos?.medium;
      if (f?.url && (f.height ?? 0) >= 720) return { url: f.url, source: "pixabay", id: String(h.id), credit: `Pixabay · ${h.user ?? ""}`.trim(), portrait: (f.height ?? 0) > (f.width ?? 0) };
    }
  } catch { /* 없음 */ }
  return null;
}

/** 음식 이름으로 무료 스톡 영상 하나. 구체 검색어로 못 찾으면 "korean food"로 한 번 더. */
export async function fetchStockClip(food: string): Promise<StockClip | null> {
  const q = stockQuery(food);
  for (const query of q === "korean food" ? [q] : [q, "korean food"]) {
    const c = (await pexels(query)) ?? (await pixabay(query));
    if (c) return c;
  }
  return null;
}
