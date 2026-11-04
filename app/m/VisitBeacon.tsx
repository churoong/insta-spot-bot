"use client";
// 맛디 지도 접속 수 기록(2026-10-28 사용자 요청). 브라우저에서 한 번 보내므로 검색 로봇·미리보기 렌더는 안 센다.
// 순방문자는 기기마다 하루 한 번(localStorage) — 시크릿 창·기기 변경은 따로 센다(대략치).
import { useEffect } from "react";

export default function VisitBeacon() {
  useEffect(() => {
    const p = location.pathname;
    const kind = p.startsWith("/e/") ? "edition" : p.startsWith("/m/") ? "pin" : "map";
    const day = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
    let first = false;
    try {
      const k = `md_visit_${day}`;
      first = !localStorage.getItem(k);
      if (first) localStorage.setItem(k, "1");
    } catch { /* 저장소 막힘 — 페이지뷰만 */ }
    fetch("/api/visit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, first }),
      keepalive: true,
    }).catch(() => {});
  }, []);
  return null;
}
