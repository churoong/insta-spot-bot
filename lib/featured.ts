// 인증·유명 맛집(미쉐린 이력·전국구 노포) 큐레이션 발행.
// 사실(선정 이력)만 언급하고, 사진·정보는 TourAPI(합법)에서 가져온다.
// 로고 사용·공식 제휴 암시는 하지 않는다.
import featuredData from "@/data/featured.json";
import { fetchImages, type Spot } from "./tourapi";
import { db } from "./db";

export interface FeaturedEntry {
  name: string;
  region: string;
  type: "michelin" | "renowned";
}

/** 캡션·DM에 쓰는 사실 기반 문구 (과장·단정 없이) */
export function featuredLabel(type: string): string {
  return type === "michelin"
    ? "미쉐린 가이드에 이름을 올린 적 있는 곳으로 알려져 있어요"
    : "전국에서 일부러 찾아온다고 소문난 유명 맛집이에요";
}

const BASE = "https://apis.data.go.kr/B551011/KorService2";

/** 이름 정규화 (공백 제거) 후 포함 관계로 매칭 */
function nameMatch(a: string, b: string): boolean {
  const na = a.replace(/\s+/g, "");
  const nb = b.replace(/\s+/g, "");
  return na.includes(nb) || nb.includes(na);
}

/**
 * 목록에서 아직 발행 안 한 인증맛집을 골라 TourAPI에서 자료 확보.
 * 조건: 검색됨 + 이름 매칭 + 공공누리 Type1/3 + 이미지 3장 이상.
 * 실패하면 null (호출부는 일반 발행으로 진행).
 */
export async function pickFeatured(): Promise<{ spot: Spot; label: string } | null> {
  const entries = (featuredData.list as FeaturedEntry[]).sort(() => Math.random() - 0.5);

  for (const entry of entries) {
    try {
      const qs = new URLSearchParams({
        serviceKey: process.env.TOUR_API_KEY!,
        MobileOS: "ETC",
        MobileApp: "instaSpotBot",
        _type: "json",
        keyword: entry.name,
        contentTypeId: "39",
        numOfRows: "5",
      });
      const res = await fetch(`${BASE}/searchKeyword2?${qs}`, {
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) continue;
      const json = await res.json();
      const raw = json?.response?.body?.items?.item;
      const items = Array.isArray(raw) ? raw : raw ? [raw] : [];

      const hit = items.find(
        (it: any) =>
          it.firstimage &&
          (it.cpyrhtDivCd === "Type1" || it.cpyrhtDivCd === "Type3") &&
          nameMatch(String(it.title), entry.name)
      );
      if (!hit) continue;

      // 이미 발행했으면 스킵
      const dup = await db.execute({
        sql: "SELECT 1 FROM posts WHERE content_id = ?",
        args: [String(hit.contentid)],
      });
      if (dup.rows.length > 0) continue;

      // 인증맛집은 이미지 3장부터 허용 (유명 노포는 사진이 적은 경우가 있음)
      const imageUrls = await fetchImages(String(hit.contentid), String(hit.firstimage));
      if (imageUrls.length < 3) continue;

      const spot: Spot = {
        contentId: String(hit.contentid),
        name: String(hit.title),
        address: [hit.addr1, hit.addr2].filter(Boolean).join(" "),
        category: "맛집",
        imageUrl: String(hit.firstimage).replace(/^http:/, "https:"),
        imageUrls,
        overview: "",
        mapx: hit.mapx ? String(hit.mapx) : undefined,
        mapy: hit.mapy ? String(hit.mapy) : undefined,
      };
      return { spot, label: featuredLabel(entry.type) };
    } catch {
      continue; // 이 항목 실패 → 다음 후보
    }
  }
  return null;
}
