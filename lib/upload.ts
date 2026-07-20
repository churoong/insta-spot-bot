// 공개 이미지 URL 업로드 (인스타 발행용). Vercel Blob 토큰 있으면 영구,
// 없으면 tmpfiles(약 60분 보관 — 인스타가 발행 시 즉시 받아가므로 충분).

export async function uploadPublicImage(buf: Buffer, name = "img"): Promise<string> {
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    try {
      const { put } = await import("@vercel/blob");
      const res = await put(`uploads/${Date.now()}-${name}.jpg`, buf, {
        access: "public",
        contentType: "image/jpeg",
        token: process.env.BLOB_READ_WRITE_TOKEN,
      });
      return res.url;
    } catch {
      /* 폴백 */
    }
  }
  // tmpfiles (Node fetch, 서버리스 OK)
  const fd = new FormData();
  fd.append("file", new Blob([new Uint8Array(buf)], { type: "image/jpeg" }), `${name}.jpg`);
  const res = await fetch("https://tmpfiles.org/api/v1/upload", {
    method: "POST",
    body: fd,
    signal: AbortSignal.timeout(30000),
  });
  const j = await res.json();
  const page = j?.data?.url?.replace("tmpfiles.org/", "tmpfiles.org/dl/");
  if (!page) throw new Error("업로드 실패: " + JSON.stringify(j).slice(0, 150));
  const html = await fetch(page, { signal: AbortSignal.timeout(15000) }).then((r) => r.text());
  const m = html.match(/href="(https:\/\/tmpfiles\.org\/dl\/[^"]+\.jpe?g)"/i);
  return m ? m[1] : page;
}
