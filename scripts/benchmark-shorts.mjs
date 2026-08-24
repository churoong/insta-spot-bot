// 맛집 쇼츠 벤치마킹 — 최근 30일 상위 조회수 쇼츠의 제목·썸네일 패턴 분석.
//
// 쇼츠와 릴스는 디자인 문법이 같아서, 유튜브 쪽 승자를 합법적으로(공식 API +
// 공개 메타데이터) 관찰하면 릴스 표지·훅 설계의 참고서가 된다. 남의 콘텐츠를
// 가져다 쓰는 게 아니라 패턴만 배운다 — 산출물은 분석 리포트뿐.
//
// 사용법: npx tsx --env-file=.env scripts/benchmark-shorts.mjs [검색어]
// 쿼터: 검색 100 + 통계 1 ≈ 101유닛 (일 10,000 중)

const K = process.env.YOUTUBE_API_KEY;
if (!K) { console.error("YOUTUBE_API_KEY 필요"); process.exit(1); }
const YT = "https://www.googleapis.com/youtube/v3";
const query = process.argv[2] || "맛집";

const after = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
const s = await (await fetch(
  `${YT}/search?part=snippet&type=video&videoDuration=short&order=viewCount&publishedAfter=${encodeURIComponent(after)}&maxResults=25&q=${encodeURIComponent(query)}&relevanceLanguage=ko&key=${K}`
)).json();
if (s.error) { console.error("검색 실패:", s.error.message); process.exit(1); }

const ids = (s.items ?? []).map((i) => i.id.videoId).filter(Boolean);
const v = await (await fetch(`${YT}/videos?part=statistics,snippet&id=${ids.join(",")}&key=${K}`)).json();
const vids = (v.items ?? [])
  .map((i) => ({
    title: i.snippet.title,
    views: Number(i.statistics.viewCount ?? 0),
    thumb: i.snippet.thumbnails?.high?.url ?? i.snippet.thumbnails?.default?.url,
  }))
  .sort((a, b) => b.views - a.views)
  .slice(0, 12);

console.log(`"${query}" 최근 30일 상위 쇼츠 ${vids.length}개:`);
for (const x of vids) console.log(`  ${(x.views / 10000).toFixed(0)}만뷰 | ${x.title.slice(0, 60)}`);

// 썸네일 비전 분석 (Gemini)
const { geminiText } = await import("../lib/llm.ts");
const parts = [];
const used = [];
for (const x of vids) {
  try {
    const r = await fetch(x.thumb, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) continue;
    const b = Buffer.from(await r.arrayBuffer());
    if (b.length > 900_000) continue;
    parts.push({ inlineData: { mimeType: "image/jpeg", data: b.toString("base64") } });
    used.push(x);
    if (parts.length >= 10) break;
  } catch { /* skip */ }
}

const prompt = `한국 "${query}" 쇼츠 중 최근 30일 조회수 상위 ${used.length}개의 썸네일(첨부)과 제목이야.

제목들:
${used.map((x, i) => `${i + 1}. [${(x.views / 10000).toFixed(0)}만뷰] ${x.title}`).join("\n")}

우리는 전국 맛집을 소개하는 인스타 릴스 계정을 자동 운영해(표지: 음식 이름 초대형 타이포 + 식당 카드 그리드 / 훅: 감탄사형 한 줄 / 나레이션 TTS).
분석해줘:
1. 썸네일 공통 디자인 패턴 — 색·타이포·인물/음식 배치·텍스트 양 (구체적으로)
2. 제목(훅) 공통 공식 — 어떤 구조가 반복되나
3. 우리 릴스에 "당장 적용할 수 있는" 개선 3가지 (우리 포맷 기준으로 구체적 지시)
4. 하지 말아야 할 것 1가지

한국어로, 각 항목 3~4줄로 압축해서.`;

const analysis = await geminiText([{ text: prompt }, ...parts], 1500);
console.log("\n===== 벤치마크 분석 =====\n" + (analysis ?? "(분석 실패)"));
