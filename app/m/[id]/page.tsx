import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Shell, { card, link } from "../Shell";
import { BRAND, BRAND_SUBJ, IG_URL, SITE, foodOf, kakaoMapLink, nearbyPins, pinById, regionOf, ymd } from "@/lib/publicmap";

export const revalidate = 86400;
// 빈 목록 = 빌드 때는 안 만들고 첫 요청 때 만들어 하루 캐시(ISR). 없으면 요청마다 DB 조회.
export async function generateStaticParams() {
  return [];
} // 하루 캐시 — 소개 내용은 발행 뒤 바뀌지 않는다

async function load(params: Promise<{ id: string }>) {
  const id = Number((await params).id);
  return Number.isInteger(id) ? pinById(id) : null;
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const p = await load(params);
  if (!p) return {};
  const r = regionOf(p.address);
  const food = foodOf(p.title);
  const title = `${p.name} — ${r.short} ${food} 맛집 | ${BRAND}`;
  const description = `${BRAND_SUBJ} '${p.title}' 편에서 ${p.rank ? `${p.rank}위로 ` : ""}소개한 ${r.short} ${food} 맛집 ${p.name}. 주소 ${p.address}.`;
  return { title, description, alternates: { canonical: `${SITE}/m/${p.id}` }, openGraph: { title, description, url: `${SITE}/m/${p.id}`, locale: "ko_KR" } };
}

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const p = await load(params);
  if (!p) notFound();
  const r = regionOf(p.address);
  const food = foodOf(p.title);
  const near = await nearbyPins(p);
  const ld = {
    "@context": "https://schema.org",
    "@type": "Restaurant",
    name: p.name,
    address: { "@type": "PostalAddress", streetAddress: p.address, addressRegion: r.sido, addressLocality: r.sigungu, addressCountry: "KR" },
    geo: { "@type": "GeoCoordinates", latitude: p.y, longitude: p.x },
    servesCuisine: food || undefined,
    hasMap: kakaoMapLink(p),
    url: `${SITE}/m/${p.id}`,
    subjectOf: { "@type": "CreativeWork", name: p.title, url: `${SITE}/e/${encodeURIComponent(p.contentId)}`, datePublished: ymd(p.postedAt), author: { "@type": "Organization", name: BRAND, url: IG_URL } },
  };
  return (
    <Shell>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(ld) }} />
      <p style={{ color: "#e02020", fontWeight: 700, margin: 0 }}>{r.short} · {food} 맛집</p>
      <h1 style={{ fontSize: 32, margin: "4px 0 12px" }}>{p.name}</h1>
      <div style={card}>
        <p style={{ margin: 0 }}>
          {BRAND_SUBJ} <a href={`/e/${encodeURIComponent(p.contentId)}`} style={link}>{p.title}</a> 편
          {p.rank ? <> {p.rank}위</> : null}로 소개한 집이에요 ({ymd(p.postedAt)}).
        </p>
        <p style={{ margin: "8px 0 0" }}>📍 {p.address}</p>
        <p style={{ margin: "8px 0 0" }}>
          <a href={kakaoMapLink(p)} style={{ color: "#e02020", fontWeight: 700 }}>카카오맵에서 길찾기</a>
          <span style={{ color: "#999" }}> · </span>
          <a href={IG_URL} style={{ color: "#555" }}>소개 영상은 인스타에서</a>
        </p>
      </div>
      {near.length ? (
        <>
          <h2 style={{ fontSize: 20, marginTop: 28 }}>근처에 소개한 맛집</h2>
          {near.map((n) => (
            <div key={n.id} style={card}>
              <a href={`/m/${n.id}`} style={link}>{n.name}</a>
              <span style={{ color: "#777", fontSize: 14 }}> · {n.km < 1 ? `${Math.round(n.km * 1000)}m` : `${n.km.toFixed(1)}km`} · {foodOf(n.title)}</span>
            </div>
          ))}
        </>
      ) : null}
    </Shell>
  );
}
