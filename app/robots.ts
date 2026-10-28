import type { MetadataRoute } from "next";
import { SITE } from "@/lib/publicmap";

// 공개 맛집 페이지만 색인. 관리 대시보드(/)·API·리다이렉트는 막는다. AI 크롤러도 같은 규칙으로 허용.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: ["/m", "/e/", "/llms.txt", "/rss.xml"], disallow: ["/api/", "/go/", "/privacy", "/$"] }],
    sitemap: `${SITE}/sitemap.xml`,
  };
}
