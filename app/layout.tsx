import type { ReactNode } from "react";

export const metadata = {
  title: "Insta Spot Bot",
  description: "맛집·여행지 인스타그램 자동 포스팅 봇 대시보드",
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
