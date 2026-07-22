// 공용 텍스트 생성 헬퍼 — Gemini(1순위) → Groq(2순위, 무료) 폴백 체인.
// 두 제공자 모두 실패하면 null 반환 → 호출부는 "게시물 생성 자체를 건너뜀"
// (저품질 기본 문구로 발행하지 않는 정책, 2026-07-22 사용자 결정).

export async function llmText(
  prompt: string,
  opts: { maxTokens?: number } = {}
): Promise<{ text: string; provider: "gemini" | "groq" } | null> {
  const maxTokens = opts.maxTokens ?? 1200;

  // 1순위: Gemini
  if (process.env.GEMINI_API_KEY) {
    try {
      const t = await geminiText([{ text: prompt }], maxTokens);
      if (t) return { text: t, provider: "gemini" };
    } catch (e) {
      console.log("[llm] Gemini 오류:", String(e).slice(0, 80));
    }
  }

  // 2순위: Groq (무료 — console.groq.com)
  if (process.env.GROQ_KEY) {
    try {
      const model = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.GROQ_KEY}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
          max_tokens: maxTokens,
          temperature: 0.8,
        }),
        signal: AbortSignal.timeout(35000),
      });
      const j = await res.json();
      const t = (j?.choices?.[0]?.message?.content ?? "").trim();
      if (t) return { text: t, provider: "groq" };
      if (j?.error) console.log("[llm] Groq 실패:", String(j.error.message ?? "").slice(0, 80));
    } catch (e) {
      console.log("[llm] Groq 오류:", String(e).slice(0, 80));
    }
  }

  return null; // 모든 AI 소진 → 호출부에서 게시물 생성 건너뜀
}

/**
 * 사용할 Gemini 모델. thinking 없는 경량 모델(gemini-flash-lite-latest)이 기본:
 * 빠르고 무료 쿼터가 넉넉하며 카드뉴스 문구·캡션 품질도 충분함.
 * ⚠️ gemini-flash-latest는 thinking 전용이라 thinkingConfig 없이도 thinking 토큰을
 * 소모해 긴 출력이 잘리고, thinkingBudget:0으로 끄려 하면 400을 뱉는다(2026-07 실측).
 * → env에 그 값이 남아 있어도 무시하고 경량 모델로 자동 교정(사용자 env 수정 불필요).
 */
export function geminiModel(): string {
  const m = process.env.GEMINI_MODEL;
  return m && m !== "gemini-flash-latest" ? m : "gemini-flash-lite-latest";
}

/**
 * Gemini 호출 (텍스트/비전 공용). thinkingConfig는 최신 모델들이 400을 반환하므로
 * 아예 보내지 않는다. thought 파트는 방어적으로 걸러 본문만 취한다.
 */
export async function geminiText(
  parts: any[],
  maxTokens: number
): Promise<string | null> {
  const model = geminiModel();
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts }], generationConfig: { maxOutputTokens: maxTokens } }),
      signal: AbortSignal.timeout(35000),
    }
  );
  const j = await res.json();
  if (j?.error) {
    console.log("[llm] Gemini 실패:", j.error.code, String(j.error.message ?? "").slice(0, 80));
    return null;
  }
  const cand = j?.candidates?.[0];
  const t = (cand?.content?.parts?.filter((p: any) => !p.thought).map((p: any) => p.text ?? "").join("") ?? "").trim();
  if (t && cand?.finishReason === "STOP") return t;
  if (t && cand?.finishReason) console.log("[llm] Gemini 응답 잘림:", cand.finishReason);
  return null;
}
