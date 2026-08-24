import { geminiText } from "./llm";

/**
 * 주어진 이미지 URL들 중 "음식이 주인공인 깨끗한 사진"만 비전으로 골라낸다.
 * fetchQuizImages(TourAPI 전용)의 비전 단계를 소스 독립적으로 뗀 것 —
 * 서울 음식관광 DB처럼 이미지 URL을 이미 갖고 있는 소스에서 쓴다.
 *
 * 반환: 먹음직스러운 순서의 URL 배열. 비전 불가·전멸이면 [] (호출부는 발행 스킵).
 */
export async function pickFoodImages(urls: string[], max = 10): Promise<string[]> {
  const cands = urls.filter(Boolean).slice(0, 12);
  if (!process.env.GEMINI_API_KEY || cands.length < 1) return [];
  try {
    const valid: string[] = [];
    const parts: any[] = [];
    for (const u of cands) {
      try {
        const res = await fetch(u, { signal: AbortSignal.timeout(15000) });
        if (!res.ok) continue;
        let b = Buffer.from(await res.arrayBuffer());
        // 서울 DB 등은 4MB급 원본이라 그냥 버리면 후보가 전멸한다(실측) — 줄여서 검사
        if (b.length > 900_000) {
          const sharp = (await import("sharp")).default;
          b = await sharp(b).resize(720, 720, { fit: "inside" }).jpeg({ quality: 78 }).toBuffer();
        }
        valid.push(u);
        parts.push({ inlineData: { mimeType: "image/jpeg", data: b.toString("base64") } });
      } catch {
        /* 죽은 링크(2021년 CDN 등)는 조용히 건너뜀 */
      }
    }
    if (valid.length < 1) return [];

    const promptText = `가게 사진 ${valid.length}장이야(1번부터). 음식(요리·메뉴)이 접시나 그릇에 담겨 먹음직스럽게 보이는 사진의 번호만 골라, 제일 먹음직스러운 순서로 JSON 배열로 답해.
⚠️다음은 음식이 조금 보여도 전부 제외:
 - 간판·상호·메뉴판·건물 외관·내부 인테리어·테이블·사람 위주 사진
 - ⭐워터마크·출처표기·촬영자 이름·블로그 주소·기관 로고가 찍힌 사진
음식이 주인공이고 워터마크 없는 깨끗한 사진만. 없으면 []. 형식: {"food":[..]}`;
    const text = (await geminiText([{ text: promptText }, ...parts], 200)) ?? "";
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return [];
    const parsed = JSON.parse(m[0]) as { food?: number[] };
    const seen = new Set<number>();
    const ordered: number[] = [];
    for (const n of (parsed.food ?? []).map(Number)) {
      if (n >= 1 && n <= valid.length && !seen.has(n)) {
        ordered.push(n);
        seen.add(n);
      }
    }
    return ordered.map((n) => valid[n - 1]).slice(0, max);
  } catch {
    return [];
  }
}
