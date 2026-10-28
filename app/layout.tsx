import type { ReactNode } from "react";

// 검색엔진 사이트 소유 확인(2026-10-28 — 네이버 서치어드바이저·구글 서치 콘솔). Vercel 환경변수에 코드만 넣으면 된다.
const verification: Record<string, unknown> = {};
if (process.env.GOOGLE_SITE_VERIFICATION) verification.google = process.env.GOOGLE_SITE_VERIFICATION;
if (process.env.NAVER_SITE_VERIFICATION) verification.other = { "naver-site-verification": process.env.NAVER_SITE_VERIFICATION };

export const metadata = {
  title: "Insta Spot Bot",
  description: "맛집·여행지 인스타그램 자동 포스팅 봇 대시보드",
  ...(Object.keys(verification).length ? { verification } : {}),
  alternates: { types: { "application/rss+xml": "/rss.xml" } },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ko">
      <body
        style={{
          margin: 0,
          fontFamily:
            "'Pretendard', -apple-system, 'Segoe UI', 'Malgun Gothic', sans-serif",
          background: "#0f1115",
          color: "#e8eaf0",
          minHeight: "100vh",
        }}
      >
        {children}
      </body>
    </html>
  );
}
