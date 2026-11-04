import { NextRequest, NextResponse } from "next/server";
import { db, initDb } from "@/lib/db";

// 맛디 지도 접속 기록 — app/m/VisitBeacon.tsx가 페이지마다 한 번 보낸다(관리 페이지에서 일별·주간·누적 표시).
const KINDS = new Set(["map", "pin", "edition"]);
const BOT = /bot|crawl|spider|slurp|preview|facebookexternalhit|headless|lighthouse/i;

export async function POST(req: NextRequest) {
  if (BOT.test(req.headers.get("user-agent") ?? "")) return NextResponse.json({ skipped: "bot" });
  let body: any = {};
  try { body = await req.json(); } catch { /* 빈 본문 */ }
  const kind = KINDS.has(body?.kind) ? body.kind : "map";
  const day = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  try {
    await initDb();
    await db.execute({
      sql: `INSERT INTO map_visits (day, kind, views, visitors) VALUES (?, ?, 1, ?)
            ON CONFLICT(day, kind) DO UPDATE SET views = views + 1, visitors = visitors + excluded.visitors`,
      args: [day, kind, body?.first ? 1 : 0],
    });
  } catch (e) {
    return NextResponse.json({ error: String(e).slice(0, 120) }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
