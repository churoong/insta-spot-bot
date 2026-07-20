// Pexels 스톡 사진 API — 무료, 상업이용 가능(출처 표기 불필요하나 크레딧은 예의).
// 특정 가게가 아니라 '테마·무드' 콘텐츠에만 사용(사칭 방지). PEXELS_KEY 없으면 비활성.
import themes from "@/data/theme-posts.json";

export interface ThemePost {
  key: string;
  title: string;
  query: string;
  hook: string;
  tags: string[];
}

/** 검색어로 세로형 스톡 사진 URL + 작가 반환 */
export async function fetchPexelsPhotos(
  query: string,
  count = 8
): Promise<{ urls: string[]; photographers: string[] }> {
  if (!process.env.PEXELS_KEY) return { urls: [], photographers: [] };
  try {
    const qs = new URLSearchParams({
      query,
      per_page: String(Math.min(20, count * 2)),
      orientation: "portrait",
      size: "large",
    });
    const res = await fetch(`https://api.pexels.com/v1/search?${qs}`, {
      headers: { Authorization: process.env.PEXELS_KEY },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return { urls: [], photographers: [] };
    const json = await res.json();
    const photos: any[] = json?.photos ?? [];
    const urls: string[] = [];
    const photographers = new Set<string>();
    for (const p of photos) {
      const url = p?.src?.large2x || p?.src?.large || p?.src?.portrait;
      if (!url) continue;
      urls.push(String(url));
      if (p.photographer) photographers.add(String(p.photographer));
      if (urls.length >= count) break;
    }
    return { urls, photographers: [...photographers].slice(0, 5) };
  } catch {
    return { urls: [], photographers: [] };
  }
}

/** Pixabay 스톡 사진 (Pexels 대안 — 무료·상업이용, 로그인만으로 키 발급) */
export async function fetchPixabayPhotos(
  query: string,
  count = 8
): Promise<{ urls: string[]; photographers: string[] }> {
  if (!process.env.PIXABAY_KEY) return { urls: [], photographers: [] };
  try {
    const qs = new URLSearchParams({
      key: process.env.PIXABAY_KEY,
      q: query,
      image_type: "photo",
      orientation: "vertical",
      per_page: String(Math.min(30, count * 3)),
      safesearch: "true",
    });
    const res = await fetch(`https://pixabay.com/api/?${qs}`, {
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return { urls: [], photographers: [] };
    const json = await res.json();
    const hits: any[] = json?.hits ?? [];
    const urls: string[] = [];
    const photographers = new Set<string>();
    for (const h of hits) {
      const url = h?.largeImageURL || h?.webformatURL;
      if (!url) continue;
      urls.push(String(url));
      if (h.user) photographers.add(String(h.user));
      if (urls.length >= count) break;
    }
    return { urls, photographers: [...photographers].slice(0, 5) };
  } catch {
    return { urls: [], photographers: [] };
  }
}

/** 테마 하나 골라 스톡 사진으로 구성 — Pexels → Pixabay 순으로 시도 (실패 시 null) */
export async function pickThemePost(
  minImages = 5
): Promise<{ theme: ThemePost; urls: string[]; credit: string } | null> {
  if (!process.env.PEXELS_KEY && !process.env.PIXABAY_KEY) return null;
  const list = (themes.themes as ThemePost[]).sort(() => Math.random() - 0.5);
  for (const t of list.slice(0, 4)) {
    if (process.env.PEXELS_KEY) {
      const { urls, photographers } = await fetchPexelsPhotos(t.query, 8);
      if (urls.length >= minImages) {
        const credit = `📷 사진: Pexels${photographers.length ? " (" + photographers.slice(0, 3).join(", ") + " 외)" : ""}`;
        return { theme: t, urls: urls.slice(0, 9), credit };
      }
    }
    if (process.env.PIXABAY_KEY) {
      const { urls, photographers } = await fetchPixabayPhotos(t.query, 8);
      if (urls.length >= minImages) {
        const credit = `📷 사진: Pixabay${photographers.length ? " (" + photographers.slice(0, 3).join(", ") + " 외)" : ""}`;
        return { theme: t, urls: urls.slice(0, 9), credit };
      }
    }
  }
  return null;
}

/** 테마 게시물 캡션 (특정 가게 아님 명확 + 참여 유도) */
export function buildThemeCaption(theme: ThemePost, credit: string): string {
  const tags = [...theme.tags, "감성", "무드", "일상스타그램"].map((t) => `#${t}`).join(" ");
  return (
    `${theme.title}\n\n` +
    `${theme.hook}\n\n` +
    `💬 여러분의 최애는 어디인가요? 추천 맛집·카페를 댓글로 남겨주세요!\n` +
    `📌 저장해두고 다음에 참고하세요\n\n` +
    `${tags}\n\n${credit}`
  );
}
