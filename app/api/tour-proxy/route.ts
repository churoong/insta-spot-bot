import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 60;

/**
 * TourAPI 프록시 — GitHub Actions가 data.go.kr에 직접 접근하지 않도록 중계한다.
 *
 * 왜 필요한가: data.go.kr이 Actions 러너의 해외·클라우드 IP를 간헐적으로 차단해
 * (ConnectTimeout) 모음집·카운트다운 발행이 통째로 실패했다. Vercel에서는 정상
 * 접근되므로 여기서 대신 호출해 결과만 넘겨준다. (릴스는 이미 reel-candidate로 우회)
 *
 * GET /api/tour-proxy?endpoint=searchKeyword2&keyword=...&numOfRows=...
 *   (Authorization: Bearer $CRON_SECRET)
 */
export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const sp = req.nextUrl.searchParams;
  const endpoint = sp.get("endpoint");
  if (!endpoint || !/^[A-Za-z0-9]+$/.test(endpoint)) {
    return NextResponse.json({ error: "invalid endpoint" }, { status: 400 });
  }

  const qs = new URLSearchParams({
    serviceKey: process.env.TOUR_API_KEY ?? "",
    MobileOS: "ETC",
    MobileApp: "instaSpotBot",
    _type: "json",
  });
  for (const [k, v] of sp.entries()) {
    if (k === "endpoint") continue;
    qs.set(k, v);
  }

  try {
    const res = await fetch(
      `https://apis.data.go.kr/B551011/KorService2/${endpoint}?${qs}`,
      { signal: AbortSignal.timeout(20000) }
    );
    if (!res.ok) {
      return NextResponse.json({ error: `TourAPI HTTP ${res.status}` }, { status: 502 });
    }
    const json = await res.json();
    const items = json?.response?.body?.items?.item;
    return NextResponse.json({ items: Array.isArray(items) ? items : items ? [items] : [] });
  } catch (e) {
    return NextResponse.json({ error: String(e).slice(0, 200) }, { status: 502 });
  }
}
