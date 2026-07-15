// 인증·유명 맛집(미쉐린 이력·전국구 노포) 큐레이션 발행.
// 사실(선정 이력)만 언급하고, 사진·정보는 TourAPI(합법)에서 가져온다.
// 로고 사용·공식 제휴 암시는 하지 않는다.
import featuredData from "@/data/featured.json";
import { fetchImages, type Spot } from "./tourapi";
import { db } from "./db";

export interface FeaturedEntry {
  name: string;
  region: string;
  type: "michelin" | "renowned" | "hundred";
}

/** 캡션·DM에 쓰는 사실 기반 문구 (과장·단정 없이) */
export function featuredLabel(type: string): string {
  if (type === "michelin") return "미쉐린 가이드에 이름을 올린 적 있는 곳으로 알려져 있어요";
  if (type === "hundred") return "중소벤처기업부가 인증한 '백년가게'로 선정된 곳이에요";
  return "전국에서 일부러 찾아온다고 소문난 유명 맛집이에요";
}

// ===== 백년가게 공공데이터 자동 동기화 =====
// 소상공인시장진흥공단_전국 백년가게 지정리스트 (data.go.kr, 월 2회 갱신, 이용제한 없음)
// TOUR_API_KEY와 같은 data.go.kr 인증키 사용 (해당 데이터셋 활용신청 필요)
const HYS_API =
  "https://api.odcloud.kr/api/15132695/v1/uddi:82fc1cc1-f636-46fc-ae0d-b1f2da5052b4";

/** 백년가게 목록을 API에서 받아 7일간 DB(config)에 캐시. 실패 시 빈 배열. */
async function fetchHundredYearPool(): Promise<FeaturedEntry[]> {
  try {
    // 캐시 확인
    const cached = await db.execute(
      "SELECT value, updated_at FROM config WHERE key = 'hys_list'"
    );
    if (cached.rows.length > 0) {
      const age =
        Date.now() -
        new Date(String(cached.rows[0].updated_at).replace(" ", "T") + "Z").getTime();
      if (age < 7 * 86_400_000) {
        return JSON.parse(String(cached.rows[0].value));
      }
    }

    // API 호출 (전체 목록) — HYS_API_KEY 우선, 없으면 TOUR_API_KEY로 시도
    const key = process.env.HYS_API_KEY || process.env.TOUR_API_KEY!;
    const res = await fetch(
      `${HYS_API}?page=1&perPage=3000&serviceKey=${encodeURIComponent(key)}`,
      { signal: AbortSignal.timeout(20000) }
    );
    const json = await res.json();
    if (!Array.isArray(json?.data) || json.data.length === 0) {
      console.log("[백년가게] API 응답 없음(활용신청 필요할 수 있음):", JSON.stringify(json).slice(0, 120));
      // 캐시가 있으면 만료됐어도 재사용
      if (cached.rows.length > 0) return JSON.parse(String(cached.rows[0].value));
      return [];
    }

    const pool: FeaturedEntry[] = json.data
      .map((r: any) => ({
        name: String(r["업체명"] ?? "").trim(),
        region: String(r["업체주소"] ?? "").split(/\s+/)[0] ?? "",
        type: "hundred" as const,
      }))
      .filter((e: FeaturedEntry) => e.name.length >= 2);

    await db.execute({
      sql: "INSERT OR REPLACE INTO config (key, value, updated_at) VALUES ('hys_list', ?, datetime('now'))",
      args: [JSON.stringify(pool)],
    });
    console.log(`[백년가게] 목록 동기화: ${pool.length}곳`);
    return pool;
  } catch (e) {
    console.error("[백년가게] 동기화 실패(무시):", e);
    return [];
  }
}

const BASE = "https://apis.data.go.kr/B551011/KorService2";

/** 이름 정규화 (공백·대괄호 태그 제거) 후 포함 관계로 매칭 */
function nameMatch(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/\[[^\]]*\]/g, "").replace(/\s+/g, "");
  const na = norm(a);
  const nb = norm(b);
  return na.includes(nb) || nb.includes(na);
}

/** 지역 대조: TourAPI 주소에 목록의 지역명(앞 2글자)이 포함되는지 (동명 가게 오매칭 방지) */
function regionMatch(addr: string, region: string): boolean {
  if (!region) return true;
  return String(addr ?? "").includes(region.slice(0, 2));
}

/**
 * 인증맛집 후보 선정: 큐레이션 목록(미쉐린 이력 등) + 백년가게 공공데이터(자동 동기화).
 * 조건: TourAPI 검색됨 + 이름 매칭 + (백년가게는 지역 대조) + 공공누리 Type1/3 + 이미지 3장 이상.
 * 실패하면 null (호출부는 일반 발행으로 진행).
 */
export async function pickFeatured(): Promise<{ spot: Spot; label: string } | null> {
  const curated = (featuredData.list as FeaturedEntry[]).sort(() => Math.random() - 0.5);
  const hundred = (await fetchHundredYearPool()).sort(() => Math.random() - 0.5);

  // 큐레이션(희소·프리미엄)과 백년가게(대규모 풀)를 반반 섞어 무작위 순서로 시도 — 후보 최대 20개
  const entries: FeaturedEntry[] = [...curated.slice(0, 10), ...hundred.slice(0, 10)].sort(
    () => Math.random() - 0.5
  );

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
          nameMatch(String(it.title), entry.name) &&
          // 동명 가게 오매칭 방지: 모든 항목에서 지역 대조 (예: 서울 진주회관 ≠ 천안 진주회관)
          regionMatch(String(it.addr1 ?? ""), entry.region)
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
