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
  imageUrls = [],
}: {
  caption: string;
  imageUrls?: string[];
}) {
  const [copied, setCopied] = useState(false);

  const [saving, setSaving] = useState(false);

  function proxyUrl(u: string, i: number) {
    return `/api/image?url=${encodeURIComponent(u)}&name=photo-${i + 1}`;
  }

  async function saveAllImages() {
    // 우리 서버 프록시를 거쳐 강제 다운로드. 브라우저 다중 다운로드 제한을
    // 피하려고 순차적으로 트리거.
    setSaving(true);
    for (let i = 0; i < imageUrls.length; i++) {
      const a = document.createElement("a");
      a.href = proxyUrl(imageUrls[i], i);
      a.download = `photo-${i + 1}.jpg`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      await new Promise((r) => setTimeout(r, 700));
    }
    setSaving(false);
  }

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
      {imageUrls.length > 0 && (
        <button onClick={saveAllImages} disabled={saving} style={btn}>
          {saving ? "⏳ 저장 중..." : `⬇️ 사진 ${imageUrls.length}장 저장`}
        </button>
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
