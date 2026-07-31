/** @type {import('next').NextConfig} */
const nextConfig = {
  // 캐러셀 표지 훅 텍스트를 sharp로 합성할 때 쓰는 한글 폰트 파일을
  // 서버리스 함수 번들에 포함시킨다(Vercel엔 시스템 한글 폰트가 없음).
  outputFileTracingIncludes: {
    "/api/cron/post": ["./assets/fonts/**"],
  },
};

export default nextConfig;
