// 한국관광공사_빅데이터_지역별 방문자수 (data.go.kr 15101972) — 시군구별 실제 방문자 수.
// KT(내국인)·SKT(외국인) 이동통신 기반, 매월 17일에 전월분 갱신, 무료.
// TOUR_API_KEY와 같은 data.go.kr 인증키를 쓰지만 **해당 데이터셋 활용신청이 따로 필요**하다.
//
// 왜 붙였나: 테마 가중치가 "이미 발행해서 조회수를 기록한 테마"로만 매겨져서, 안 해본
// 테마는 전부 같은 값(2.0)이었다. 2026-09-08 실측 로그에서 상권 47개 중 45개가 '미시도'였다.
// 그런데 조회수는 지역 인지도를 그대로 따라간다(성수 857 > 춘천 247 > 대전 유성 95).
// 즉 한 번 태워봐야만 아는 구조였는데, 방문자 수는 그걸 **사전에** 알려준다.
//
// ⚠️ 응답 스키마를 문서로 확인하지 못했다(작업 세션에서 data.go.kr 접근이 막혀 있었다).
//    그래서 파서를 필드명 패턴으로 관대하게 짰고, 경로는 env로 바꿀 수 있게 뒀다.
//    실물 확인은 `scripts/probe-visitors.mjs`(러너에서 실행)로 한다.
//    무엇이 됐든 실패하면 null을 돌려 기존 동작(평탄한 가중치)으로 돌아간다.

import { db } from "./db";

const BASE = "https://apis.data.go.kr/B551011";
// 운영 경로가 확실하지 않아 후보를 순서대로 시도한다. 프로브로 확정되면 VISITOR_API_PATH로 고정.
const PATH_CANDIDATES = [
  "DataLabService/metcoRegnVisitrDDList",
  "DataLabService/locgoRegnVisitrDDList",
  "TatsCnctrRateService/tatsCnctrRatedList",
];

const CACHE_KEY = "visitor_stats";
const CACHE_DAYS = 30; // 월 1회 갱신 데이터

export type VisitorStats = Record<string, number>; // 시군구명 → 방문자 수

/** data.go.kr 응답 어디에 있든 item 배열을 찾아낸다 (JSON/래핑 형태가 서비스마다 다르다) */
function findItems(json: any): any[] {
  const seen = new Set<any>();
  const walk = (node: any, depth: number): any[] | null => {
    if (!node || typeof node !== "object" || depth > 6 || seen.has(node)) return null;
    seen.add(node);
    if (Array.isArray(node)) {
      return node.length && typeof node[0] === "object" ? node : null;
    }
    // items.item 형태가 표준이지만 item이 단일 객체로 오는 경우도 있다
    if (node.item) return Array.isArray(node.item) ? node.item : [node.item];
    for (const v of Object.values(node)) {
      const hit = walk(v, depth + 1);
      if (hit) return hit;
    }
    return null;
  };
  return walk(json, 0) ?? [];
}

const pick = (row: any, re: RegExp): string | null => {
  for (const [k, v] of Object.entries(row)) {
    if (re.test(k) && v != null && String(v) !== "") return String(v);
  }
  return null;
};

/** 한 행에서 (시군구명, 방문자수)를 뽑는다. 필드명이 서비스마다 달라 패턴으로 찾는다. */
export function parseRow(row: any): [string, number] | null {
  const name = pick(row, /signgu.*nm|sgng.*nm|area.*nm|region.*nm|시군구/i);
  const raw = pick(row, /touNum|visit|방문/i);
  if (!name || raw == null) return null;
  const n = Number(String(raw).replace(/[^\d.]/g, ""));
  if (!Number.isFinite(n) || n <= 0) return null;
  return [name.trim(), n];
}

/** 전월(데이터가 아직 없을 수 있어 두 달 전까지 되짚는다) YYYYMM 목록 */
function recentMonths(): string[] {
  const out: string[] = [];
  const d = new Date();
  for (let i = 1; i <= 3; i++) {
    const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1));
    out.push(`${m.getUTCFullYear()}${String(m.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}

async function callOnce(path: string, ym: string): Promise<VisitorStats | null> {
  const key = process.env.TOUR_API_KEY;
  if (!key) return null;
  const qs = new URLSearchParams({
    serviceKey: decodeURIComponent(key),
    MobileOS: "ETC",
    MobileApp: "insta-spot-bot",
    _type: "json",
    numOfRows: "1000",
    pageNo: "1",
    startYmd: `${ym}01`,
    endYmd: `${ym}31`,
  });
  const res = await fetch(`${BASE}/${path}?${qs}`, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) return null;
  const text = await res.text();
  // 인증 실패·미신청은 XML 에러로 온다 — JSON 파싱 전에 걸러 로그를 남긴다
  if (!text.trim().startsWith("{")) {
    const reason = text.match(/<returnAuthMsg>([^<]*)</)?.[1] ?? text.slice(0, 120);
    console.error(`[visitors] ${path} 비JSON 응답: ${reason}`);
    return null;
  }
  const stats: VisitorStats = {};
  for (const row of findItems(JSON.parse(text))) {
    const kv = parseRow(row);
    if (!kv) continue;
    // 같은 시군구가 일자별로 여러 행이면 합산 (월 합계가 곧 규모)
    stats[kv[0]] = (stats[kv[0]] ?? 0) + kv[1];
  }
  return Object.keys(stats).length >= 10 ? stats : null; // 너무 적으면 파싱 실패로 본다
}

/**
 * 시군구별 방문자 수. 30일 캐시(월 1회 갱신 데이터라 매 발행마다 부를 이유가 없다).
 * 키 없음·미신청·스키마 불일치 등 어떤 이유로든 실패하면 null → 호출부는 기존 동작 유지.
 */
export async function fetchVisitorStats(): Promise<VisitorStats | null> {
  try {
    const cached = await db.execute({
      sql: "SELECT value, updated_at FROM config WHERE key = ?",
      args: [CACHE_KEY],
    });
    if (cached.rows.length) {
      const age =
        Date.now() -
        new Date(String(cached.rows[0].updated_at).replace(" ", "T") + "Z").getTime();
      if (age < CACHE_DAYS * 86_400_000) {
        const v = JSON.parse(String(cached.rows[0].value));
        if (v && Object.keys(v).length) return v;
      }
    }
  } catch { /* 캐시 실패는 무시하고 새로 받는다 */ }

  const paths = process.env.VISITOR_API_PATH
    ? [process.env.VISITOR_API_PATH]
    : PATH_CANDIDATES;
  for (const path of paths) {
    for (const ym of recentMonths()) {
      try {
        const stats = await callOnce(path, ym);
        if (!stats) continue;
        console.log(`[visitors] ${path} ${ym} — 시군구 ${Object.keys(stats).length}개`);
        try {
          await db.execute({
            sql: "INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))",
            args: [CACHE_KEY, JSON.stringify(stats)],
          });
        } catch { /* 캐시 저장 실패는 무시 */ }
        return stats;
      } catch (e) {
        console.error(`[visitors] ${path} ${ym} 실패:`, String(e).slice(0, 100));
      }
    }
  }
  return null;
}

// ===== 테마 → 시군구 해석 =====
// 방문자 데이터는 시군구 단위라 테마를 시군구에 붙여야 한다. 손으로 68개를 적으면
// 틀리기 쉬워서, 이미 쓰고 있는 카카오 로컬 API로 좌표·지명에서 뽑는다.
//   상권 테마: mapX/mapY → coord2regioncode → region_2depth_name
//   도시 테마: keyword → search/address → region_2depth_name
// 결과는 config에 영구 캐시한다(테마 좌표가 바뀌지 않는 한 다시 부를 이유가 없다).

const SGG_CACHE_KEY = "theme_sgg";

async function kakao(path: string, params: Record<string, string>): Promise<any | null> {
  const key = process.env.KAKAO_REST_KEY;
  if (!key) return null;
  const res = await fetch(`https://dapi.kakao.com/v2/local/${path}?${new URLSearchParams(params)}`, {
    headers: { Authorization: `KakaoAK ${key}` },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) return null;
  return res.json();
}

/** 지역명("서울 강남구" 등)에서 시군구만 — 방문자 데이터의 키와 맞추기 위해 */
async function sigunguOf(theme: any): Promise<string | null> {
  try {
    const t = theme.tour ?? {};
    if (t.mapX && t.mapY) {
      const j = await kakao("geo/coord2regioncode.json", { x: String(t.mapX), y: String(t.mapY) });
      const d = (j?.documents ?? []).find((x: any) => x.region_type === "B") ?? j?.documents?.[0];
      return d?.region_2depth_name ? String(d.region_2depth_name) : null;
    }
    if (theme.keyword) {
      const j = await kakao("search/address.json", { query: String(theme.keyword), size: "1" });
      const d = j?.documents?.[0]?.address ?? j?.documents?.[0]?.road_address;
      return d?.region_2depth_name ? String(d.region_2depth_name) : null;
    }
  } catch { /* 개별 실패는 null */ }
  return null;
}

/**
 * 테마키 → 시군구명 매핑. 캐시에 없는 테마만 카카오로 조회하고 결과를 합쳐 저장한다.
 * 카카오 키가 없거나 전부 실패하면 빈 객체 — 호출부는 기존 동작 유지.
 */
export async function resolveThemeSigungu(themes: any[]): Promise<Record<string, string>> {
  let map: Record<string, string> = {};
  try {
    const c = await db.execute({ sql: "SELECT value FROM config WHERE key = ?", args: [SGG_CACHE_KEY] });
    if (c.rows.length) map = JSON.parse(String(c.rows[0].value)) ?? {};
  } catch { /* 캐시 없음 */ }

  const missing = themes.filter((t) => !(t.key in map));
  if (!missing.length) return map;

  // 첫 실행에 68개를 다 부르면 발행이 그만큼 늦어진다 — 시간 예산을 두고 남은 건 다음 회차에.
  const deadline = Date.now() + 20_000;
  let added = 0;
  for (const t of missing) {
    if (Date.now() > deadline) break;
    const sgg = await sigunguOf(t);
    map[t.key] = sgg ?? ""; // 실패도 기록해 매번 다시 부르지 않게 (빈 문자열 = 해석 불가)
    if (sgg) added++;
  }
  if (added) {
    console.log(`[visitors] 시군구 해석 +${added}곳 (누적 ${Object.values(map).filter(Boolean).length})`);
    try {
      await db.execute({
        sql: "INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))",
        args: [SGG_CACHE_KEY, JSON.stringify(map)],
      });
    } catch { /* 저장 실패는 무시 */ }
  }
  return map;
}
