import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Shell, { card, link } from "../../m/Shell";
import { BRAND, SITE, igHandle, igUrl, editionById, regionOf, ymd } from "@/lib/publicmap";

export const revalidate = 86400;
// 빈 목록 = 빌드 때는 안 만들고 첫 요청 때 만들어 하루 캐시(ISR). 없으면 요청마다 DB 조회.
export async function generateStaticParams() {
  return [];
}

async function load(params: Promise<{ cid: string }>) {
  return editionById(decodeURIComponent((await params).cid));
}

export async function generateMetadata({ params }: { params: Promise<{ cid: string }> }): Promise<Metadata> {
  const e = await load(params);
  if (!e) return {};
  const title = `${e.title} | ${BRAND}`;
  const description = `${e.title}: ${e.places.map((p) => p.name).join(", ")}. ${BRAND} 전국 맛집 큐레이션.`;
  const url = `${SITE}/e/${encodeURIComponent(e.contentId)}`;
  return { title, description, alternates: { canonical: url }, openGraph: { title, description, url, locale: "ko_KR" } };
}

export default async function Page({ params }: { params: Promise<{ cid: string }> }) {
  const e = await load(params);
  if (!e) notFound();
  const h = await igHandle();
  const IG_URL = igUrl(h);
  const ld = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: e.title,
    datePublished: ymd(e.postedAt),
    author: { "@type": "Organization", name: BRAND, url: IG_URL },
    itemListElement: e.places.map((p) => ({
      "@type": "ListItem",
      position: p.rank,
      item: { "@type": "Restaurant", name: p.name, address: p.address, ...(p.pinId ? { url: `${SITE}/m/${p.pinId}` } : {}) },
    })),
  };
  return (
    <Shell>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(ld) }} />
      <h1 style={{ fontSize: 30, margin: "0 0 4px" }}>{e.title}</h1>
      <p style={{ color: "#777", marginTop: 0 }}>{ymd(e.postedAt)} · {BRAND}</p>
      {e.places.map((p) => (
        <div key={p.rank} style={card}>
          <span style={{ color: "#e02020", fontWeight: 800, marginRight: 8 }}>{p.rank}</span>
          {p.pinId ? <a href={`/m/${p.pinId}`} style={link}>{p.name}</a> : <b>{p.name}</b>}
          <div style={{ color: "#666", fontSize: 14 }}>{regionOf(p.address).short || p.address}</div>
        </div>
      ))}
      <p style={{ marginTop: 20 }}><a href={IG_URL} style={{ color: "#e02020", fontWeight: 700 }}>영상으로 보기 — 인스타 @{h}</a></p>
    </Shell>
  );
}
