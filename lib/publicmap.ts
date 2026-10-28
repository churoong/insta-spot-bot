// 공개 맛집 페이지(AI 검색 노출용, 2026-10-27 사용자 결정) — /m, /m/[id], /e/[cid], sitemap, llms.txt가 같이 쓴다.
// ChatGPT·퍼플렉시티·구글 AI 요약이 "○○ 국밥 맛집"에 답할 때 인용할 수 있게, 소개한 식당마다
// 크롤러가 읽는 정적 HTML + JSON-LD를 둔다. 데이터는 map_pins(좌표) + posts(어느 편 몇 위)뿐.
// 식당 평가는 긍정만 — 평점·리뷰 수 같은 숫자는 만들어 넣지 않는다(없는 사실을 구조화 데이터에 넣으면 안 된다).
import { db, initDb } from "@/lib/db";

export const BRAND = "맛디깅"; // 계정 이름이 바뀌면 여기 한 줄만
/** 브랜드 + 주격 조사(받침 있으면 "이", 없으면 "가") — 이름을 바꿔도 문장이 안 깨지게 */
export const BRAND_SUBJ = (() => {
  const c = BRAND.charCodeAt(BRAND.length - 1) - 0xac00;
  return BRAND + (c >= 0 && c < 11172 && c % 28 ? "이" : "가");
})();
/** 인스타 아이디 — 에이전트가 바꾸면 config.ig_handle(2026-10-27 맛디깅 개명). 페이지는 igHandle()로 읽는다. */
export const DEFAULT_HANDLE = "matdigging";
export async function igHandle(): Promise<string> {
  try {
    await initDb();
    const v = (await db.execute("SELECT value FROM config WHERE key = 'ig_handle'")).rows[0]?.value;
    return v ? String(v) : DEFAULT_HANDLE;
  } catch {
    return DEFAULT_HANDLE;
  }
}
export const igUrl = (h: string) => `https://www.instagram.com/${h}/`;
export const SITE = (process.env.PUBLIC_SITE_URL || "https://insta-spot-bot.vercel.app").replace(/\/$/, "");

const SIDO: Record<string, string> = {
  서울특별시: "서울", 부산광역시: "부산", 대구광역시: "대구", 인천광역시: "인천", 광주광역시: "광주",
  대전광역시: "대전", 울산광역시: "울산", 세종특별자치시: "세종", 경기도: "경기", 강원도: "강원",
  강원특별자치도: "강원", 충청북도: "충북", 충청남도: "충남", 전라북도: "전북", 전북특별자치도: "전북",
  전라남도: "전남", 경상북도: "경북", 경상남도: "경남", 제주특별자치도: "제주",
};

export interface Pin {
  id: number;
  name: string;
  address: string;
  x: number;
  y: number;
  contentId: string;
  createdAt: string;
  title: string; // 소개한 편 제목
  rank: number | null; // 그 편에서 몇 번째
  postedAt: string;
}

export interface Edition {
  contentId: string;
  title: string;
  postedAt: string;
  places: { rank: number; name: string; address: string; pinId: number | null }[];
}

/** "부산광역시 해운대구 …" → { sido: "부산", sigungu: "해운대구", short: "부산 해운대구" } */
export function regionOf(address: string) {
  const [a, b] = String(address ?? "").trim().split(/\s+/);
  const sido = SIDO[a] ?? (a && a.length <= 4 ? a : "");
  const sigungu = b && /[시군구]$/.test(b) ? b : "";
  return { sido, sigungu, short: [sido, sigungu].filter(Boolean).join(" ") };
}

/** posts.address 줄("N. 상호 — 주소")에서 순위 찾기 */
function rankIn(lines: string, name: string): number | null {
  for (const l of String(lines ?? "").split("\n")) {
    const m = l.match(/^(\d+)\.\s*(.+?)\s+—\s+/);
    if (m && m[2].trim() === name) return Number(m[1]);
  }
  return null;
}

/** 편 제목에서 음식명 추정 — "전국 돼지국밥 6대 맛집" → "돼지국밥" */
export function foodOf(title: string): string {
  const t = String(title ?? "").replace(/\d+대\s*맛집.*$/, "").trim().split(/\s+/);
  return t[t.length - 1] ?? "";
}

const PIN_SQL = `SELECT m.id, m.name, m.address, m.x, m.y, m.content_id, m.created_at,
  p.place_name AS title, p.address AS lines, p.created_at AS posted_at
  FROM map_pins m JOIN posts p ON p.content_id = m.content_id
  WHERE p.status = 'published'`;

function toPin(r: any): Pin {
  return {
    id: Number(r.id),
    name: String(r.name),
    address: String(r.address ?? ""),
    x: Number(r.x),
    y: Number(r.y),
    contentId: String(r.content_id),
    createdAt: String(r.created_at ?? ""),
    title: String(r.title ?? ""),
    rank: rankIn(String(r.lines ?? ""), String(r.name)),
    postedAt: String(r.posted_at ?? ""),
  };
}

export async function allPins(): Promise<Pin[]> {
  await initDb();
  return (await db.execute(`${PIN_SQL} ORDER BY m.id DESC`)).rows.map(toPin);
}

export async function pinById(id: number): Promise<Pin | null> {
  await initDb();
  const r = await db.execute({ sql: `${PIN_SQL} AND m.id = ?`, args: [id] });
  return r.rows[0] ? toPin(r.rows[0]) : null;
}

/** 좌표 기준 가까운 소개 식당(자기 제외) */
export async function nearbyPins(p: Pin, n = 5, maxKm = 15): Promise<(Pin & { km: number })[]> {
  const km = (a: Pin) => Math.hypot((a.x - p.x) * 88.2, (a.y - p.y) * 111);
  return (await allPins())
    .filter((a) => a.id !== p.id && a.name !== p.name)
    .map((a) => ({ ...a, km: km(a) }))
    .filter((a) => a.km <= maxKm)
    .sort((a, b) => a.km - b.km)
    .slice(0, n);
}

export async function editionById(cid: string): Promise<Edition | null> {
  await initDb();
  const r = await db.execute({
    sql: "SELECT content_id, place_name, address, created_at FROM posts WHERE content_id = ? AND status = 'published'",
    args: [cid],
  });
  const row = r.rows[0];
  if (!row) return null;
  const pins = (await db.execute({ sql: "SELECT id, name FROM map_pins WHERE content_id = ?", args: [cid] })).rows;
  const byName = new Map(pins.map((p: any) => [String(p.name), Number(p.id)]));
  const places = String(row.address ?? "").split("\n").flatMap((l) => {
    const m = l.match(/^(\d+)\.\s*(.+?)\s+—\s+(.*)$/);
    return m ? [{ rank: Number(m[1]), name: m[2].trim(), address: m[3].trim(), pinId: byName.get(m[2].trim()) ?? null }] : [];
  });
  return { contentId: cid, title: String(row.place_name), postedAt: String(row.created_at ?? ""), places };
}

/** 지도 핀이 있는(=식당 목록이 있는) 공개 편들 */
export async function allEditions(): Promise<{ contentId: string; title: string; postedAt: string }[]> {
  await initDb();
  const r = await db.execute(`SELECT DISTINCT p.content_id, p.place_name, p.created_at FROM posts p
    JOIN map_pins m ON m.content_id = p.content_id WHERE p.status = 'published' ORDER BY p.created_at DESC`);
  return r.rows.map((x: any) => ({ contentId: String(x.content_id), title: String(x.place_name), postedAt: String(x.created_at ?? "") }));
}

export const kakaoMapLink = (p: { name: string; x: number; y: number }) =>
  `https://map.kakao.com/link/map/${encodeURIComponent(p.name)},${p.y},${p.x}`;

export const ymd = (s: string) => String(s ?? "").slice(0, 10);
