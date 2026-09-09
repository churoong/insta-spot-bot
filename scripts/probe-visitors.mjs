// 지역별 방문자수 API 실물 확인 — 발행은 하지 않는다.
// ⚠️ 완전한 읽기 전용은 아니다: 캐시로 config에 visitor_stats_v2 / theme_sgg_v2 두 줄을 쓴다
//    (실제 코드 경로를 그대로 태워야 결과가 의미가 있어서 그렇다). posts는 건드리지 않는다.
//   npx tsx --env-file=.env scripts/probe-visitors.mjs
//   (러너: report.yml 을 probe=true 로 실행)
//
// 왜 필요한가: 이 API의 스펙 페이지(data.go.kr)와 호스트가 작업 세션 네트워크에서 막혀
// 있어 **응답 스키마를 문서로 확인하지 못했다**. lib/visitors.ts 는 필드명 패턴으로
// 관대하게 파싱하지만, 실제 응답을 한 번은 눈으로 봐야 경로·필드를 확정할 수 있다.
//
// 확인하는 것:
//   1) TOUR_API_KEY로 이 데이터셋이 열리는가 (활용신청이 따로 필요하다)
//   2) 어느 경로가 사는가 (PATH_CANDIDATES 중)
//   3) 응답 필드명이 무엇이고 파서가 시군구·방문자수를 뽑아내는가
//   4) 테마 68개가 (시도, 시군구)로 해석되는가 (카카오)
//   5) 시도가 응답에 있는가 — 없으면 동명 시군구(중구·동구…)를 갈라낼 수 없어
//      해당 테마들은 가중치 없이 남는다
import fs from "node:fs";

const BASE = "https://apis.data.go.kr/B551011";
const PATHS = process.env.VISITOR_API_PATH
  ? [process.env.VISITOR_API_PATH]
  : [
      "DataLabService/metcoRegnVisitrDDList",
      "DataLabService/locgoRegnVisitrDDList",
      "TatsCnctrRateService/tatsCnctrRatedList",
    ];

const months = () => {
  const d = new Date(), out = [];
  for (let i = 1; i <= 3; i++) {
    const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1));
    out.push(`${m.getUTCFullYear()}${String(m.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return out;
};

// 토큰이 URL 쿼리에 실려 예외 메시지로 새지 않게 가린다
const safe = (s) => String(s).replace(/serviceKey=[^&\s"']+/g, "serviceKey=***");

async function main() {
  if (!process.env.TOUR_API_KEY) throw new Error("TOUR_API_KEY 없음");
  let winner = null;

  for (const path of PATHS) {
    for (const ym of months()) {
      const qs = new URLSearchParams({
        serviceKey: decodeURIComponent(process.env.TOUR_API_KEY),
        MobileOS: "ETC",
        MobileApp: "insta-spot-bot",
        _type: "json",
        numOfRows: "10",
        pageNo: "1",
        startYmd: `${ym}01`,
        endYmd: `${ym}31`,
      });
      let res, text;
      try {
        res = await fetch(`${BASE}/${path}?${qs}`, { signal: AbortSignal.timeout(20000) });
        text = await res.text();
      } catch (e) {
        console.log(`✗ ${path} ${ym} — 요청 실패: ${safe(e).slice(0, 120)}`);
        continue;
      }
      if (!text.trim().startsWith("{")) {
        const msg =
          text.match(/<returnAuthMsg>([^<]*)</)?.[1] ??
          text.match(/<errMsg>([^<]*)</)?.[1] ??
          text.replace(/\s+/g, " ").slice(0, 140);
        console.log(`✗ ${path} ${ym} — HTTP ${res.status}, 비JSON: ${msg}`);
        continue;
      }
      console.log(`\n✅ ${path} ${ym} — JSON 응답 (HTTP ${res.status})`);
      console.log("── 원문 앞 1200자 ──\n" + text.slice(0, 1200));
      winner = { path, ym, text };
      break;
    }
    if (winner) break;
  }

  if (!winner) {
    console.log(
      "\n❌ 살아 있는 경로가 없습니다.\n" +
        "  - 'SERVICE_KEY_IS_NOT_REGISTERED_ERROR'면 이 데이터셋 활용신청이 아직 안 된 것입니다\n" +
        "    (공공데이터포털 > 한국관광공사_빅데이터_지역별 방문자수 > 활용신청, 승인은 보통 즉시)\n" +
        "  - 경로 자체가 다르면 스펙 문서에서 확인해 VISITOR_API_PATH 로 지정하세요."
    );
    process.exit(1);
  }

  // 파서가 실제로 뽑아내는지 — lib/visitors.ts 의 것과 같은 로직을 태운다
  const { parseRow, lookupVisitors } = await import("../lib/visitors.ts");
  const json = JSON.parse(winner.text);
  const items = json?.response?.body?.items?.item ?? json?.response?.body?.items ?? [];
  const rows = Array.isArray(items) ? items : [items];
  console.log(`\n── 파싱 결과 (${rows.length}행) ──`);
  console.log("응답 필드명:", Object.keys(rows[0] ?? {}).join(", ") || "(없음)");
  console.log("totalCount:", json?.response?.body?.totalCount ?? "(없음)");
  // 방문자 구분(현지인/외지인/외국인)이 섞여 있으면 합계 의미가 달라진다 — 값 분포를 본다
  const divKeys = Object.keys(rows[0] ?? {}).filter((k) => /div|gubun|se$|구분/i.test(k));
  for (const k of divKeys) {
    const vals = [...new Set(rows.map((r) => String(r[k])))].slice(0, 8);
    console.log(`  구분 후보 ${k}: ${vals.join(" / ")}`);
  }
  if (!divKeys.length) console.log("  구분 필드 없음 — 시군구별 단일 값으로 보입니다");
  let ok = 0, noSido = 0;
  for (const r of rows.slice(0, 10)) {
    const kv = parseRow(r);
    if (!kv) continue;
    ok++;
    if (!kv.sido) noSido++;
    console.log(`  ${kv.sido || "(시도없음)"} ${kv.sgg} — ${kv.n.toLocaleString()}`);
  }
  if (!ok) {
    console.log("  ⚠️ 파서가 한 행도 못 뽑았습니다 — 위 필드명에 맞게 lib/visitors.ts parseRow 정규식을 고치세요.");
  } else if (noSido) {
    console.log(`  ⚠️ ${noSido}/${ok}행에 시도가 없습니다 — 동명 시군구(중구·동구·서구·남구·북구)는`);
    console.log("     갈라낼 수 없어 그 테마들은 가중치 없이 남습니다. 응답에 시도 필드가 있다면");
    console.log("     lib/visitors.ts parseRow의 시도 정규식에 그 필드명을 추가하세요.");
  }

  // 테마 → 지역 해석 (카카오) + 실제로 가중치가 붙는 테마 수.
  // 마지막 숫자가 이 연동의 진짜 성과다 — 해석은 됐는데 방문자 데이터와 안 맞으면 0이다.
  const data = JSON.parse(fs.readFileSync(new URL("../data/roundup-themes.json", import.meta.url), "utf8"));
  const themes = (data.themes ?? data).filter((t) => t.mode === "area");
  console.log(`\n── 테마 지역 해석 (지역편 ${themes.length}개, 카카오) ──`);
  if (!process.env.KAKAO_REST_KEY) {
    console.log("  KAKAO_REST_KEY 없음 — 해석 불가(사전 가중치도 동작하지 않습니다)");
    return;
  }
  const { resolveThemeRegions, fetchVisitorStats, clearVisitorCache } = await import("../lib/visitors.ts");
  const map = await resolveThemeRegions(themes);
  const done = themes.filter((t) => map[t.key]?.sgg);
  console.log(`  해석 ${done.length}/${themes.length}곳`);
  for (const t of themes.slice(0, 12)) {
    const r = map[t.key];
    console.log(`  ${t.key} → ${r?.sgg ? `${r.sido || "(시도없음)"} ${r.sgg}` : "(실패)"}`);
  }
  const failedResolve = themes.filter((t) => !map[t.key]?.sgg).map((t) => t.key);
  if (failedResolve.length) console.log(`  해석 실패: ${failedResolve.join(", ")}`);

  // 전체 통계로 매칭. 프로브는 **캐시를 먼저 지우고** 실제 호출을 강제한다 —
  // 안 그러면 옛 캐시를 읽어 파서 수정이 반영됐는지 확인할 수 없다. 끝나고도 지운다:
  // 프로브가 알려준 대로 parseRow를 고쳐도 잘못된 캐시가 30일간 살아 있으면 소용없다.
  await clearVisitorCache();
  const stats = await fetchVisitorStats();
  await clearVisitorCache();
  if (!stats) {
    console.log("\n  ⚠️ 전체 통계를 못 받아 매칭 수를 셀 수 없습니다.");
    return;
  }
  const matched = [], unmatched = [];
  for (const t of themes) {
    const r = map[t.key];
    const v = r?.sgg ? lookupVisitors(stats, r) : null;
    (v != null ? matched : unmatched).push(t.key);
  }
  console.log(`\n── 가중치가 붙는 테마: ${matched.length}/${themes.length} ──`);
  if (unmatched.length) {
    console.log(`  미확정(기존 2.0 유지): ${unmatched.join(", ")}`);
    console.log("  ※ 동명 시군구(중구·동구·서구·남구·북구)를 시도로 못 가르면 일부러 포기합니다 —");
    console.log("    잘못 붙은 가중치는 조용히 틀린 선택을 만들고 나중에 원인을 찾을 수 없습니다.");
  }
}

main().catch((e) => {
  console.error("프로브 실패:", safe(e && e.stack ? e.stack : e));
  process.exit(1);
});
