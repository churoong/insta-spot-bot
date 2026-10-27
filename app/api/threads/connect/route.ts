import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { threadsRedirectUri } from "@/lib/threads";

/**
 * 스레드 계정 연결 시작(한 번만) — 이 주소를 열면 스레드 권한 화면으로 보낸다.
 * 앱이 검수 전이라 'Threads 테스터'로 등록된 계정(@tourist_710)만 허용할 수 있다.
 */
export async function GET() {
  if (!process.env.THREADS_APP_ID || !process.env.THREADS_APP_SECRET) {
    return new NextResponse("Vercel 환경변수 THREADS_APP_ID / THREADS_APP_SECRET 이 없습니다.", { status: 500 });
  }
  const state = randomBytes(16).toString("hex");
  const url = new URL("https://threads.com/oauth/authorize");
  url.searchParams.set("client_id", process.env.THREADS_APP_ID);
  url.searchParams.set("redirect_uri", threadsRedirectUri());
  url.searchParams.set("scope", "threads_basic,threads_content_publish,threads_manage_insights");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  const res = NextResponse.redirect(url.toString());
  res.cookies.set("th_state", state, { httpOnly: true, secure: true, sameSite: "lax", maxAge: 600, path: "/api/threads" });
  return res;
}
