"use client";

import { useState } from "react";

const btn: React.CSSProperties = {
  fontSize: 12.5,
  fontWeight: 600,
  color: "#e8eaf0",
  background: "#2a2e38",
  border: "1px solid #3a3f4b",
  borderRadius: 8,
  padding: "7px 12px",
  cursor: "pointer",
  textDecoration: "none",
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
};

export default function PostActions({
  caption,
  imageUrl,
}: {
  caption: string;
  imageUrl?: string | null;
}) {
  const [copied, setCopied] = useState(false);

  async function copyCaption() {
    try {
      await navigator.clipboard.writeText(caption);
    } catch {
      // 클립보드 API 실패 시 폴백
      const ta = document.createElement("textarea");
      ta.value = caption;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  return (
    <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
      <button
        onClick={copyCaption}
        style={{
          ...btn,
          background: copied ? "#1e3a2a" : "#2a2e38",
          borderColor: copied ? "#2f6b45" : "#3a3f4b",
          color: copied ? "#7ee0a8" : "#e8eaf0",
        }}
      >
        {copied ? "✅ 복사됨!" : "📋 캡션 복사"}
      </button>
      {imageUrl && (
        <a href={imageUrl} target="_blank" rel="noopener noreferrer" style={btn}>
          🖼️ 이미지 열기 · 저장
        </a>
      )}
      <a
        href="https://www.instagram.com/"
        target="_blank"
        rel="noopener noreferrer"
        style={btn}
      >
        📷 인스타 열기
      </a>
    </div>
  );
}
