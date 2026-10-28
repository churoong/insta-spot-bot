"use client";
// 맛디 지도(2026-10-28 사용자 결정) — 소개한 맛집 핀(맛디 아이콘) + "내 주변" + 국경선 색 지도 층.
// Leaflet은 CDN에서 불러온다(번들·의존성 추가 없음). 타일은 OpenStreetMap — 출처 표기 필수, 가벼운 사용만.
import { useEffect, useRef, useState } from "react";

export interface MapPin { id: number; name: string; x: number; y: number; food: string; title: string }
interface BorderSeries { key: string; food: string }
interface BorderData { food: string; types: { key: string; color: string }[]; winners: Record<string, string> }

const LEAFLET = "https://unpkg.com/leaflet@1.9.4/dist/leaflet";

function loadLeaflet(): Promise<any> {
  const w = window as any;
  if (w.L) return Promise.resolve(w.L);
  return new Promise((resolve, reject) => {
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = `${LEAFLET}.css`;
    document.head.appendChild(css);
    const js = document.createElement("script");
    js.src = `${LEAFLET}.js`;
    js.onload = () => resolve(w.L);
    js.onerror = reject;
    document.head.appendChild(js);
  });
}

const btn: React.CSSProperties = {
  border: "1px solid #e3d7c6", background: "#fff", borderRadius: 999, padding: "7px 14px",
  fontSize: 14, fontWeight: 700, color: "#1d1a17", cursor: "pointer",
};

export default function MapView({ pins }: { pins: MapPin[] }) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<any>(null);
  const layer = useRef<any>(null);
  const [series, setSeries] = useState<BorderSeries[]>([]);
  const [active, setActive] = useState<string>("");
  const [legend, setLegend] = useState<BorderData | null>(null);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    let alive = true;
    loadLeaflet().then((L) => {
      if (!alive || !el.current || map.current) return;
      const m = L.map(el.current, { zoomControl: true, attributionControl: true }).setView([36.3, 127.8], 7);
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 18, attribution: "&copy; OpenStreetMap contributors",
      }).addTo(m);
      const icon = L.icon({ iconUrl: "/mascot.png", iconSize: [38, 38], iconAnchor: [19, 34], popupAnchor: [0, -30] });
      for (const p of pins) {
        L.marker([p.y, p.x], { icon, title: p.name })
          .addTo(m)
          .bindPopup(`<b>${p.name.replace(/</g, "&lt;")}</b><br>${p.food} · ${p.title.replace(/</g, "&lt;")}<br><a href="/m/${p.id}">자세히 보기 →</a>`);
      }
      map.current = m;
    }).catch(() => setMsg("지도를 불러오지 못했어요. 아래 목록을 이용해 주세요."));
    fetch("/border/index.json").then((r) => (r.ok ? r.json() : [])).then((s) => alive && setSeries(s)).catch(() => {});
    return () => { alive = false; };
  }, [pins]);

  async function showBorder(key: string) {
    const L = (window as any).L;
    if (!L || !map.current) return;
    if (layer.current) { map.current.removeLayer(layer.current); layer.current = null; }
    if (!key || key === active) { setActive(""); setLegend(null); return; }
    const [geo, data] = await Promise.all([
      fetch("/geo/sigungu.json").then((r) => r.json()),
      fetch(`/border/${key}.json`).then((r) => r.json()) as Promise<BorderData>,
    ]);
    const color = Object.fromEntries(data.types.map((t) => [t.key, t.color]));
    layer.current = L.geoJSON(geo, {
      style: (f: any) => {
        const w = data.winners[f.properties.code];
        return { color: "#fff", weight: 0.6, fillColor: w ? color[w] : "#d9d2c5", fillOpacity: w ? 0.6 : 0.25 };
      },
      onEachFeature: (f: any, l: any) => {
        const w = data.winners[f.properties.code];
        l.bindTooltip(`${f.properties.name}${w ? ` · ${w}` : ""}`, { sticky: true });
      },
    }).addTo(map.current);
    setActive(key);
    setLegend(data);
  }

  function nearMe() {
    if (!navigator.geolocation) return setMsg("이 브라우저는 위치를 지원하지 않아요.");
    setMsg("위치 확인 중…");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const L = (window as any).L;
        const { latitude: lat, longitude: lng } = pos.coords;
        map.current?.setView([lat, lng], 13);
        if (L && map.current) L.circleMarker([lat, lng], { radius: 8, color: "#e02020", fillOpacity: 1 }).addTo(map.current).bindTooltip("내 위치");
        const near = pins.filter((p) => Math.hypot((p.x - lng) * 88.2, (p.y - lat) * 111) <= 5).length;
        setMsg(near ? `반경 5km에 맛디깅이 소개한 맛집 ${near}곳` : "반경 5km에는 아직 소개한 집이 없어요. 지도를 넓혀 보세요.");
      },
      () => setMsg("위치 권한이 없어 내 주변을 찾지 못했어요."),
      { enableHighAccuracy: false, timeout: 10000 },
    );
  }

  return (
    <div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, margin: "12px 0" }}>
        <button style={{ ...btn, background: "#e02020", color: "#fff", borderColor: "#e02020" }} onClick={nearMe}>📍 내 주변 맛집</button>
        {series.map((s) => (
          <button key={s.key} style={{ ...btn, ...(active === s.key ? { background: "#1d1a17", color: "#fff" } : {}) }} onClick={() => showBorder(s.key)}>
            🗺 {s.food} 국경선
          </button>
        ))}
      </div>
      <div ref={el} style={{ width: "100%", height: "62vh", minHeight: 360, borderRadius: 14, overflow: "hidden", border: "1px solid #ebe3d6", background: "#efe9df" }} />
      {legend ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 8, fontSize: 13 }}>
          {legend.types.map((t) => (
            <span key={t.key}><span style={{ display: "inline-block", width: 12, height: 12, borderRadius: 3, background: t.color, marginRight: 4, verticalAlign: -1 }} />{t.key}</span>
          ))}
          <span style={{ color: "#888" }}>· 전국 평균보다 유난히 많은 {legend.food}</span>
        </div>
      ) : null}
      {msg ? <p style={{ margin: "8px 0 0", color: "#555", fontSize: 14 }}>{msg}</p> : null}
    </div>
  );
}
