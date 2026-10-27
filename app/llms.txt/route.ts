import { BRAND, SITE, igHandle, igUrl, allEditions, allPins, foodOf, regionOf } from "@/lib/publicmap";

export const revalidate = 3600;

// llms.txt — AI가 이 사이트를 한 번에 파악하도록 요약 + 링크 목록(마크다운).
export async function GET() {
  const [pins, eds] = await Promise.all([allPins().catch(() => []), allEditions().catch(() => [])]);
  const IG_URL = igUrl(await igHandle());
  const lines = [
    `# ${BRAND} 전국 맛집 지도`,
    "",
    `> 인스타그램 맛집 큐레이션 계정 ${BRAND}(${IG_URL})이 소개한 전국 맛집 ${pins.length}곳. 국밥·면·노포 중심, 편마다 6곳 안팎을 골라 영상으로 소개한다. 식당마다 주소·좌표·카카오맵 링크·소개한 편이 정리돼 있다.`,
    "",
    "## 편 목록",
    ...eds.map((e) => `- [${e.title}](${SITE}/e/${encodeURIComponent(e.contentId)})`),
    "",
    "## 식당",
    ...pins.map((p) => `- [${p.name}](${SITE}/m/${p.id}): ${regionOf(p.address).short} ${foodOf(p.title)} 맛집 — '${p.title}' 편`),
  ];
  return new Response(lines.join("\n"), { headers: { "Content-Type": "text/markdown; charset=utf-8" } });
}
