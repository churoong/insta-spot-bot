"use client";

import { useState } from "react";

const inp: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  background: "#12151b",
  border: "1px solid #2a2e38",
  borderRadius: 8,
  padding: "9px 11px",
  color: "#e8eaf0",
  fontSize: 14,
  marginTop: 4,
};
const label: React.CSSProperties = { fontSize: 12.5, color: "#9aa0ae" };

export default function UploadForm() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [files, setFiles] = useState<File[]>([]);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setMsg(null);
    const f = e.currentTarget;
    const fd = new FormData(f);
    if (files.length === 0) {
      setMsg({ ok: false, text: "사진을 1장 이상 선택해주세요." });
      return;
    }
    fd.delete("images");
    files.slice(0, 10).forEach((file) => fd.append("images", file));
    const secret = (fd.get("secret") as string) || "";
    if (secret) localStorage.setItem("mine_secret", secret);

    setBusy(true);
    try {
      const res = await fetch("/api/publish-mine", { method: "POST", body: fd });
      const j = await res.json();
      if (res.ok) {
        setMsg({ ok: true, text: j.message || "접수됐어요! 잠시 후 발행됩니다. (새로고침하면 목록에 표시)" });
        f.reset();
        setFiles([]);
      } else {
        setMsg({ ok: false, text: j.error || "실패했습니다." });
      }
    } catch (err) {
      setMsg({ ok: false, text: "네트워크 오류: " + String(err).slice(0, 100) });
    } finally {
      setBusy(false);
    }
  }

  const savedSecret = typeof window !== "undefined" ? localStorage.getItem("mine_secret") ?? "" : "";

  return (
    <div
      style={{
        background: "#1a1d24",
        border: "1px solid #2a2e38",
        borderRadius: 12,
        padding: "14px 16px",
        marginBottom: 16,
      }}
    >
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          background: "none",
          border: "none",
          color: "#e8eaf0",
          fontWeight: 700,
          fontSize: 15,
          cursor: "pointer",
          padding: 0,
        }}
      >
        📸 내 사진으로 게시하기 {open ? "▲" : "▼"}
      </button>
      {open && (
        <form onSubmit={submit} style={{ marginTop: 12 }}>
          <div style={{ color: "#9aa0ae", fontSize: 12.5, marginBottom: 10, lineHeight: 1.6 }}>
            직접 찍은 사진을 올리면 봇이 캡션·해시태그를 붙여 인스타에 캐러셀로 발행해요.
            (내 사진은 저작권 문제 없음 · 최대 10장)
          </div>

          <label style={label}>사진 (여러 장 선택 가능)</label>
          <input
            type="file"
            accept="image/*"
            multiple
            onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
            style={{ ...inp, padding: 8 }}
          />
          {files.length > 0 && (
            <div style={{ color: "#7ee0a8", fontSize: 12, marginTop: 4 }}>{files.length}장 선택됨</div>
          )}

          <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
            <div style={{ flex: 2 }}>
              <label style={label}>상호명 / 장소명 *</label>
              <input name="name" required placeholder="예: 밀양돼지국밥" style={inp} />
            </div>
            <div style={{ flex: 1 }}>
              <label style={label}>분류</label>
              <select name="category" style={inp} defaultValue="맛집">
                <option value="맛집">맛집</option>
                <option value="여행지">여행지</option>
              </select>
            </div>
          </div>

          <div style={{ marginTop: 10 }}>
            <label style={label}>지역 (시/구)</label>
            <input name="region" placeholder="예: 부산 부산진구" style={inp} />
          </div>

          <div style={{ marginTop: 10 }}>
            <label style={label}>한줄 메모 (선택 — 봇이 이걸 살려서 캡션 작성)</label>
            <textarea
              name="note"
              rows={2}
              placeholder="예: 국물이 진하고 수육이 부드러워요. 웨이팅 있지만 강추!"
              style={{ ...inp, resize: "vertical" }}
            />
          </div>

          <div style={{ marginTop: 10 }}>
            <label style={label}>관리 비밀번호 (CRON_SECRET)</label>
            <input name="secret" type="password" defaultValue={savedSecret} required placeholder="발행 권한 확인용" style={inp} />
          </div>

          <button
            type="submit"
            disabled={busy}
            style={{
              marginTop: 14,
              width: "100%",
              background: busy ? "#3a3f4b" : "#d92121",
              color: "#fff",
              border: "none",
              borderRadius: 8,
              padding: "11px",
              fontSize: 14.5,
              fontWeight: 700,
              cursor: busy ? "default" : "pointer",
            }}
          >
            {busy ? "업로드 중..." : "🚀 인스타에 발행하기"}
          </button>

          {msg && (
            <div
              style={{
                marginTop: 10,
                fontSize: 13,
                color: msg.ok ? "#7ee0a8" : "#e08080",
                lineHeight: 1.6,
              }}
            >
              {msg.text}
            </div>
          )}
        </form>
      )}
    </div>
  );
}
