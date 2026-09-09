// lookupVisitors 매칭 규칙 테스트 — 네트워크·시크릿 없이 돈다.
//   npx tsx scripts/test-visitors.mjs
//
// 왜 필요한가: 시군구는 이름만으로 식별되지 않는다. 중구·동구·서구·남구·북구는
// 여러 시에 동시에 있어서(대전 중구 / 부산 중구 / 대구 중구 …) 부분일치로 붙이면
// 조용히 틀린 가중치가 생기고, 나중에 성과를 봐도 원인을 찾을 수 없다.
// 실제 API 응답은 이 세션에서 확인할 수 없지만, **매칭 규칙 자체는 여기서 증명된다.**
import { lookupVisitors, normSido, sggCandidates } from "../lib/visitors.ts";

let fail = 0;
const eq = (name, got, want) => {
  const ok = got === want;
  if (!ok) fail++;
  console.log(`${ok ? "✅" : "❌"} ${name}${ok ? "" : ` — got ${got}, want ${want}`}`);
};

// 시도가 붙은 정상 데이터: 동명 시군구가 여럿이어도 정확히 갈라야 한다
const withSido = {
  "대전|유성구": 500,
  "대전|중구": 300,
  "부산|중구": 900,
  "대구|중구": 700,
  "서울|강남구": 4000,
  "강원|강릉시": 1200,
  "경남|창원시 성산구": 800,
  "세종|세종": 250,
};
eq("대전 중구 → 대전 값", lookupVisitors(withSido, { sido: "대전", sgg: "중구" }), 300);
eq("부산 중구 → 부산 값", lookupVisitors(withSido, { sido: "부산", sgg: "중구" }), 900);
eq("대전 유성구", lookupVisitors(withSido, { sido: "대전", sgg: "유성구" }), 500);
eq("서울 강남구", lookupVisitors(withSido, { sido: "서울", sgg: "강남구" }), 4000);
eq("강원 강릉시", lookupVisitors(withSido, { sido: "강원", sgg: "강릉시" }), 1200);
eq("세종(단층제)", lookupVisitors(withSido, { sido: "세종", sgg: "세종" }), 250);
eq("창원시 성산구 (2단 시군구)", lookupVisitors(withSido, { sido: "경남", sgg: "창원시 성산구" }), 800);
eq("없는 시군구 → null", lookupVisitors(withSido, { sido: "경기", sgg: "없는구" }), null);
eq("시도 불일치 → null", lookupVisitors(withSido, { sido: "광주", sgg: "중구" }), null);

// 시도를 모르는 경우(카카오 해석 실패). 동명이 여럿이면 **찍지 말고 포기**해야 한다.
eq("시도 모름 + 동명 여럿 → null", lookupVisitors(withSido, { sido: "", sgg: "중구" }), null);
eq("시도 모름 + 유일 → 값", lookupVisitors(withSido, { sido: "", sgg: "유성구" }), 500);

// 데이터에 시도가 아예 없는 경우(응답에 시도 필드가 없을 때).
// ⚠️ 이때 "|중구"는 전국 중구가 한 칸에 합쳐진 값이다. "응답 안에서 유일"은
//    "내가 찾는 그 도시"라는 뜻이 아니다 — 모호한 이름은 거절해야 한다.
//    (직전 버전은 이걸 값으로 인정했고, 이 테스트가 그 잘못된 동작을 정답으로 박아 뒀다)
const noSido = { "|유성구": 500, "|중구": 300, "|강남구": 4000, "|해운대구": 700 };
eq("데이터 시도없음 + 유일·비모호 → 값", lookupVisitors(noSido, { sido: "대전", sgg: "유성구" }), 500);
eq("데이터 시도없음 + 해운대구 → 값", lookupVisitors(noSido, { sido: "부산", sgg: "해운대구" }), 700);
eq("데이터 시도없음 + 중구 → null (전국 합산이라 못 씀)", lookupVisitors(noSido, { sido: "부산", sgg: "중구" }), null);
eq("데이터 시도없음 + 남구 → null", lookupVisitors(noSido, { sido: "부산", sgg: "남구" }), null);
eq("데이터 시도없음 + 고성군 → null (강원·경남 중복)", lookupVisitors(noSido, { sido: "강원", sgg: "고성군" }), null);
// '남구'가 '강남구'에 substring으로 걸리던 사고 — 이제 정확 일치만 본다
eq("남구가 강남구를 물지 않는다", lookupVisitors({ "부산|강남구": 9 }, { sido: "부산", sgg: "남구" }), null);

// 시도 표기 정규화
eq("대전광역시 → 대전", normSido("대전광역시"), "대전");
eq("강원특별자치도 → 강원", normSido("강원특별자치도"), "강원");
eq("전북특별자치도 → 전북", normSido("전북특별자치도"), "전북");
eq("제주특별자치도 → 제주", normSido("제주특별자치도"), "제주");
eq("서울 → 서울", normSido("서울"), "서울");
eq("빈 값 → 빈 문자열", normSido(null), "");

// 2단 시군구 후보 생성
eq("창원시 성산구 후보 수", sggCandidates("창원시 성산구").length, 3);
eq("유성구 후보 수", sggCandidates("유성구").length, 1);

console.log(fail ? `\n❌ ${fail}건 실패` : "\n✅ 전부 통과");
process.exit(fail ? 1 : 0);
