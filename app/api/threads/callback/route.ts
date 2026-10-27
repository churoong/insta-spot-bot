import { NextRequest, NextResponse } from "next/server";
import { connectThreads } from "@/lib/threads";

export const maxDuration = 30;

/** 스레드 권한 허용 후 돌아오는 곳 — 토큰을 DB에 저장한다(발행은 GitHub 러너가 DB에서 꺼내 쓴다). */
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const html = (msg: string, status = 200) =>
    new NextResponse(`<meta charset="utf-8"><meta name="viewport" content="width=device-width"><p style="font:18px sans-serif;padding:24px">${msg}</p>`, {
      status, headers: { "content-type": "text/html; charset=utf-8" },
    });
  if (!code) return html(`연결 취소됨: ${req.nextUrl.searchParams.get("error_description") ?? "코드 없음"}`, 400);
  if (!state || state !== req.cookies.get("th_state")?.value) return html("확인 값이 맞지 않습니다. /api/threads/connect 를 다시 여세요.", 400);
  try {
    const who = await connectThreads(code);
    return html(`✅ 스레드 연결 완료: @${who}<br>다음 모음집부터 스레드에도 같이 올라갑니다.`);
  } catch (e) {
    return html(`❌ 연결 실패: ${String(e).slice(0, 300)}`, 500);
  }
}
