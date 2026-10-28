import type { ReactNode } from "react";
import { BRAND, igHandle, igUrl } from "@/lib/publicmap";
import VisitBeacon from "./VisitBeacon";

// 공개 페이지 공통 틀 — 루트 레이아웃(관리 대시보드)은 어두운 배경이라 여기서 밝게 덮는다.
export default async function Shell({ children }: { children: ReactNode }) {
  const h = await igHandle();
  return (
    <div style={{ background: "#f6f1e7", color: "#1d1a17", minHeight: "100vh" }}>
      <VisitBeacon />
      <main style={{ maxWidth: 720, margin: "0 auto", padding: "28px 16px 64px", lineHeight: 1.65 }}>
        <nav style={{ fontSize: 14, marginBottom: 20 }}>
          <a href="/m" style={{ color: "#e02020", fontWeight: 700, textDecoration: "none" }}>{BRAND} 전국 맛집 지도</a>
          <span style={{ color: "#999" }}> · </span>
          <a href={igUrl(h)} style={{ color: "#555" }}>인스타 @{h}</a>
        </nav>
        {children}
      </main>
    </div>
  );
}

export const card: React.CSSProperties = {
  background: "#fff", borderRadius: 12, padding: "14px 16px", marginBottom: 10, border: "1px solid #ebe3d6",
};
export const link: React.CSSProperties = { color: "#1d1a17", fontWeight: 700, textDecoration: "none" };
