// 위키미디어 공용(Wikimedia Commons) — CC 라이선스 여행지 사진 (키 불필요).
// 상업이용 가능한 라이선스(CC0/PD/CC BY/CC BY-SA)만 사용하고, 작가·라이선스를 캡션에 표기.
import landmarks from "@/data/landmarks.json";
import type { Spot } from "./tourapi";

const API = "https://commons.wikimedia.org/w/api.php";

// 허용: 퍼블릭도메인, CC0, CC BY, CC BY-SA. 제외: NC(비상업), ND(변경금지) 등.
function licenseOk(short: string): boolean {
  const s = (short || "").toLowerCase();
  if (/nc|nd|non-?commercial|noncommercial/.test(s)) return false;
  return /cc0|cc by|cc-by|public domain|pd|attribution/.test(s) || s.includes("cc by-sa");
}

const strip = (html: string) => String(html || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();

export interface WikimediaResult {
  urls: string[];
  credits: string[]; // "작가 (라이선스)"
}

/** 검색어로 CC 사진 최대 max장 + 출처(작가·라이선스) 반환 */
export async function fetchWikimediaPhotos(keyword: string, max = 8): Promise<WikimediaResult> {
  try {
    const qs = new URLSearchParams({
      action: "query",
      generator: "search",
      gsrsearch: `${keyword}`,
      gsrnamespace: "6", // 파일
      gsrlimit: "20",
      prop: "imageinfo",
      iiprop: "url|size|extmetadata|mime",
      iiurlwidth: "1080",
      format: "json",
      origin: "*",
    });
    const res = await fetch(`${API}?${qs}`, {
      headers: { "User-Agent": "insta-spot-bot/1.0 (contact: operator)" },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return { urls: [], credits: [] };
    const json = await res.json();
    const pages = Object.values(json?.query?.pages ?? {}) as any[];

    const urls: string[] = [];
    const creditSet = new Set<string>();
    for (const p of pages) {
      const ii = p.imageinfo?.[0];
      if (!ii) continue;
      const mime = String(ii.mime ?? "");
      if (!/image\/(jpeg|png)/.test(mime)) continue; // svg/gif 제외
      const m = ii.extmetadata ?? {};
      const lic = m.LicenseShortName?.value ?? "";
      if (!licenseOk(lic)) continue;
      const w = Number(ii.thumbwidth ?? 0);
      if (w < 800) continue; // 너무 작은 건 제외
      const url = String(ii.thumburl ?? ii.url ?? "");
      if (!url) continue;
      urls.push(url);
      const artist = strip(m.Artist?.value ?? "").slice(0, 30) || "Wikimedia";
      creditSet.add(`${artist} (${lic})`);
      if (urls.length >= max) break;
    }
    return { urls, credits: [...creditSet].slice(0, 5) };
  } catch {
    return { urls: [], credits: [] };
  }
}

/**
 * 유명 여행지 목록에서 하나 골라 위키미디어 CC 사진으로 Spot 구성.
 * TourAPI로 overview(설명)를 보강. 사진 부족하면 null.
 */
export async function pickWikimediaSpot(minImages = 5): Promise<{ spot: Spot; credit: string } | null> {
  const list = (landmarks.list as { name: string; region: string }[]).sort(() => Math.random() - 0.5);

  for (const lm of list.slice(0, 6)) {
    const { urls, credits } = await fetchWikimediaPhotos(lm.name, 8);
    if (urls.length < minImages) continue;

    const spot: Spot = {
      contentId: `wiki-${lm.name}`,
      name: lm.name,
      address: lm.region,
      category: "여행지",
      imageUrl: urls[0],
      imageUrls: urls,
      overview: "", // 설명은 캡션 생성기가 분위기로 작성
    };
    const credit = `📷 사진: ${credits.join(", ")} · 위키미디어 공용`;
    return { spot, credit };
  }
  return null;
}
