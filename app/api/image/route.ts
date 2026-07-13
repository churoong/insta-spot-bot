import { NextRequest } from "next/server";

export const maxDuration = 30;

// 이미지 저장용 프록시. visitkorea 이미지는 CORS 미허용이라 브라우저에서 직접
// 다운로드가 안 됨 → 서버가 대신 받아 Content-Disposition으로 강제 다운로드.
// SSRF 방지: 한국관광공사 이미지 호스트만 허용.
const ALLOWED_HOSTS = ["tong.visitkorea.or.kr"];

export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get("url");
  const name = (req.nextUrl.searchParams.get("name") || "photo").replace(/[^\w.-]/g, "");
  if (!raw) return new Response("missing url", { status: 400 });

  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return new Response("bad url", { status: 400 });
  }
  if (!ALLOWED_HOSTS.includes(target.hostname)) {
    return new Response("forbidden host", { status: 403 });
  }

  const upstream = await fetch(target.toString(), {
    signal: AbortSignal.timeout(20000),
  });
  if (!upstream.ok) return new Response("upstream error", { status: 502 });

  const contentType = upstream.headers.get("content-type") || "image/jpeg";
  const ext = contentType.includes("png") ? "png" : "jpg";
  const buf = await upstream.arrayBuffer();

  return new Response(buf, {
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="${name}.${ext}"`,
      "Cache-Control": "public, max-age=86400",
    },
  });
}
