/** @type {import('next').NextConfig} */
const nextConfig = {
  // Vercel 서버리스 번들은 정적 추적된 파일만 배포된다 — fs.readFileSync로 읽는
  // 데이터는 여기 명시해야 프로덕션에서 존재한다.
  // ⚠️ 2026-08-24 실측: 이 항목이 커밋에서 누락돼 서울 소스가 프로덕션에서
  //    조용히 비활성(파일 없음 → 빈 배열 폴백)이었던 사고가 있었다. 새 데이터
  //    파일을 추가하면 반드시 여기에도 추가하고 /api/reel-candidate?diag=1로 검증할 것.
  outputFileTracingIncludes: {
    // 캐러셀 표지 훅 텍스트 합성용 한글 폰트 (Vercel엔 시스템 한글 폰트가 없음)
    "/api/cron/post": ["./assets/fonts/**"],
    // 서울 음식관광 DB + 착한가격업소 (reel-candidate가 런타임에 읽음)
    "/api/reel-candidate": ["./data/seoul-food.json", "./data/goodprice.json"],
  },
};

export default nextConfig;
