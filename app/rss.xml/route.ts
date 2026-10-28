import { BRAND, SITE, allEditions, editionById, igHandle, igUrl } from "@/lib/publicmap";

export const revalidate = 3600;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// RSS — 네이버 서치어드바이저는 RSS 제출로 새 글을 빨리 수집한다(2026-10-28 계정 노출).
export async function GET() {
  const eds = (await allEditions().catch(() => [])).slice(0, 30);
  const items = await Promise.all(eds.map(async (e) => {
    const full = await editionById(e.contentId).catch(() => null);
    const url = `${SITE}/e/${encodeURIComponent(e.contentId)}`;
    const desc = full ? full.places.map((p) => `${p.rank}. ${p.name}`).join(" · ") : e.title;
    const date = new Date(String(e.postedAt).replace(" ", "T") + "Z");
    return `<item><title>${esc(e.title)}</title><link>${url}</link><guid>${url}</guid>${isNaN(+date) ? "" : `<pubDate>${date.toUTCString()}</pubDate>`}<description>${esc(desc)}</description></item>`;
  }));
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title>${esc(BRAND)} 맛집 지도</title><link>${SITE}/m</link>
<description>${esc(BRAND)}(${igUrl(await igHandle())})이 소개한 전국 국밥·면·노포 맛집</description>
<language>ko</language>
${items.join("\n")}
</channel></rss>`;
  return new Response(xml, { headers: { "Content-Type": "application/rss+xml; charset=utf-8" } });
}
