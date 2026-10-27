// IndexNow — 새 공개 페이지를 Bing·네이버 등에 즉시 알린다(무료, 키 파일 방식).
// ChatGPT 검색은 Bing 색인을 쓰므로 발행 직후 알리면 AI 답변에 잡히는 시점이 빨라진다.
// 키는 공개용이다(검증 파일 public/46d28bdf53d2b74b8bde474bf3c121ab.txt와 같은 값) — 비밀이 아니다.
// 스크립트(tsx)에서도 불리므로 DB를 끌고 오는 publicmap을 import하지 않는다.
const SITE = (process.env.PUBLIC_SITE_URL || "https://insta-spot-bot.vercel.app").replace(/\/$/, "");

export const INDEXNOW_KEY = "46d28bdf53d2b74b8bde474bf3c121ab";

export async function pingIndexNow(paths: string[]): Promise<number> {
  const urlList = [...new Set(paths)].map((p) => (p.startsWith("http") ? p : `${SITE}${p}`));
  if (!urlList.length) return 0;
  const res = await fetch("https://api.indexnow.org/indexnow", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ host: new URL(SITE).host, key: INDEXNOW_KEY, keyLocation: `${SITE}/${INDEXNOW_KEY}.txt`, urlList }),
    signal: AbortSignal.timeout(15000),
  });
  return res.status; // 200·202 = 접수
}
