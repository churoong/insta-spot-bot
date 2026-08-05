// Gemini TTS 공용 헬퍼 — 릴스 나레이션 음성 생성.
// 스크립트(make-reel / make-roundup)가 공유한다. wav 변환·속도 조절은 ffmpeg가
// 필요해 호출부(Actions 스크립트)에서 처리하고, 여기서는 raw PCM만 만든다.
//
// ⚠️ 무료 등급은 일일 한도가 낮다. 릴스 1개당 '한 번'만 호출할 것
//    (문장마다 부르면 하루치 한도를 금방 소진한다 — 2026-08 실측 429).

export interface TtsResult {
  pcm: Buffer; // raw PCM (L16 mono)
  rate: number; // 샘플레이트 (보통 24000)
}

/** 페르소나 설정(data/persona.json)에서 목소리·톤을 읽어온다 */
export function ttsVoiceConfig(persona: any): { voice: string; direction: string; speed: number } {
  return {
    voice: process.env.TTS_VOICE || persona?.voice || "Leda",
    direction: persona?.voiceDirection || "",
    speed: Number(process.env.TTS_SPEED || persona?.voiceSpeed || 1),
  };
}

/**
 * 텍스트를 음성 PCM으로 변환. 실패하면 null(호출부는 무음으로 진행).
 */
export async function ttsPcm(
  text: string,
  opts: { voice?: string; direction?: string } = {}
): Promise<TtsResult | null> {
  const key = process.env.GEMINI_API_KEY;
  if (!key || !text.trim()) return null;
  const model = process.env.TTS_MODEL || "gemini-2.5-flash-preview-tts";
  // 스타일 지시를 앞에 붙이면 같은 목소리도 훨씬 생동감 있게 읽는다
  const prompt = opts.direction ? `${opts.direction}: ${text}` : text;
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: { prebuiltVoiceConfig: { voiceName: opts.voice || "Leda" } },
            },
          },
        }),
        signal: AbortSignal.timeout(90000),
      }
    );
    const j = await res.json();
    const inline = j?.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData)?.inlineData;
    if (!inline?.data) {
      console.error(
        "[tts] 오디오 없음:",
        j?.error ? `${j.error.code} ${String(j.error.message).slice(0, 90)}` : "inlineData 없음"
      );
      return null;
    }
    const rate = Number(/rate=(\d+)/.exec(inline.mimeType || "")?.[1] || 24000);
    return { pcm: Buffer.from(inline.data, "base64"), rate };
  } catch (e) {
    console.error("[tts] 실패:", String(e).slice(0, 100));
    return null;
  }
}
