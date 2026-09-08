import { NextRequest, NextResponse } from "next/server";
import { db, initDb } from "@/lib/db";
import { findPlace, searchMapUrl } from "@/lib/kakao";

/**
 * 모음집 지도 DM용 짧은 리다이렉트 — /go/{posts.id}/{n} → 네이버 지도 검색.
 * 인스타 DM은 1,000바이트 한도라 긴 지도 URL 6개를 못 담는다. 본문엔 이 짧은 링크만 넣는다.
 * posts.address 에는 "N. 상호 — 주소" 줄들이 저장돼 있다(make-roundup).
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ post: string; n: string }> }) {
  const { post, n } = await ctx.params;
  const id = Number(post), idx = Number(n);
  if (!Number.isInteger(id) || !Number.isInteger(idx)) return new NextResponse("bad request", { status: 400 });
  try {
    await initDb();
    const r = await db.execute({ sql: "SELECT address FROM posts WHERE id = ?", args: [id] });
    const lines = String(r.rows[0]?.address ?? "").split("\n");
    const line = lines.find((l) => l.trim().startsWith(`${idx}.`));
    const m = line?.match(/^\d+\.\s*(.+?)\s*—\s*(.+)$/);
    if (!m) return new NextResponse("not found", { status: 404 });
    const name = m[1].trim();
    const region = m[2].split(/\s+/).slice(0, 2).join(" ");
    // 카카오맵에서 그 가게를 찾으면 상세 페이지로 바로 보낸다(길찾기·영업시간까지 한 번에).
    // 못 찾거나 KAKAO_REST_KEY가 없으면 네이버 지도 '검색' 링크로 폴백 — 실측상 7%가 미등록.
    const kp = await findPlace(name, region).catch(() => null);
    return NextResponse.redirect(kp?.placeUrl || searchMapUrl(name, region), 302);
  } catch (e) {
    return new NextResponse(String(e).slice(0, 100), { status: 500 });
  }
}
