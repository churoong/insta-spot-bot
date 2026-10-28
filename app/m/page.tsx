import type { Metadata } from "next";
import Shell, { card, link } from "./Shell";
import MapView from "./MapView";
import { BRAND, BRAND_SUBJ, SITE, allEditions, allPins, foodOf, regionOf } from "@/lib/publicmap";

export const revalidate = 3600;

export const metadata: Metadata = {
  title: `${BRAND} 맛집 지도 — 내 주변 국밥·면·노포 맛집`,
  description: `${BRAND_SUBJ} 인스타에서 소개한 전국 맛집을 시도별로 모았어요. 국밥·면·노포 맛집 지도.`,
  alternates: { canonical: `${SITE}/m` },
};

export default async function Page() {
  const [pins, eds] = await Promise.all([allPins(), allEditions()]);
  const bySido = new Map<string, typeof pins>();
  for (const p of pins) {
    const s = regionOf(p.address).sido || "기타";
    if (!bySido.has(s)) bySido.set(s, []);
    bySido.get(s)!.push(p);
  }
  return (
    <Shell>
      <h1 style={{ fontSize: 32, margin: "0 0 4px", display: "flex", alignItems: "center", gap: 10 }}>
        <img src="/mascot.png" alt="" width={48} height={48} /> 맛디 지도
      </h1>
      <p style={{ color: "#666", marginTop: 0 }}>{BRAND_SUBJ} 소개한 맛집 {pins.length}곳 · {eds.length}편</p>
      <MapView pins={pins.map((p) => ({ id: p.id, name: p.name, x: p.x, y: p.y, food: foodOf(p.title), title: p.title }))} />
      <h2 style={{ fontSize: 20, marginTop: 24 }}>최근 편</h2>
      {eds.slice(0, 12).map((e) => (
        <div key={e.contentId} style={card}><a href={`/e/${encodeURIComponent(e.contentId)}`} style={link}>{e.title}</a></div>
      ))}
      {[...bySido.entries()].sort((a, b) => b[1].length - a[1].length).map(([s, list]) => (
        <section key={s}>
          <h2 style={{ fontSize: 20, marginTop: 28 }}>{s} <span style={{ color: "#999", fontSize: 15 }}>{list.length}곳</span></h2>
          <p style={{ margin: 0 }}>
            {list.map((p, i) => (
              <span key={p.id}>
                {i ? <span style={{ color: "#bbb" }}> · </span> : null}
                <a href={`/m/${p.id}`} style={{ color: "#1d1a17" }}>{p.name}</a>
                <span style={{ color: "#999", fontSize: 13 }}> {foodOf(p.title)}</span>
              </span>
            ))}
          </p>
        </section>
      ))}
    </Shell>
  );
}
