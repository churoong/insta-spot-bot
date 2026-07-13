import type { Spot } from "./tourapi";

const SOURCE_LINE = "📷 사진·정보 출처: 한국관광공사 TourAPI";

export interface CaptionResult {
  caption: string; // 해시태그 포함 완성본
}

function keyword() {
  return process.env.DM_KEYWORD || "어디야";
}

/**
 * 장소명을 숨긴 티저형 캡션 + 해시태그 생성.
 * GEMINI_API_KEY가 있으면 Gemini 무료 등급 사용, 없으면 내장 템플릿 폴백.
 * 규칙: 상호명/정확한 장소명은 본문·해시태그 모두 금지,
 * 댓글 키워드 + 팔로우 → DM 안내 문구 포함, 출처 명시.
 */
export async function generateCaption(spot: Spot): Promise<CaptionResult> {
  if (process.env.GEMINI_API_KEY) {
    try {
      return await generateWithGemini(spot);
    } catch (e) {
      console.error("Gemini 실패, 템플릿 폴백 사용:", e);
    }
  }
  return generateWithTemplate(spot);
}

// ===== 1순위: Google Gemini (무료 등급 — 하루 1,500회, 카드 불필요) =====

async function generateWithGemini(spot: Spot): Promise<CaptionResult> {
  const model = process.env.GEMINI_MODEL || "gemini-flash-latest";
  const prompt = `인스타그램 ${spot.category} 소개 계정의 게시글 캡션을 한국어로 작성해줘.

장소 정보:
- 이름: ${spot.name} (절대 캡션에 쓰지 말 것!)
- 주소: ${spot.address}
- 분류: ${spot.category}
- 설명: ${spot.overview || "(설명 없음 — 사진 분위기와 지역 특성으로 작성)"}

작성 규칙:
1. 장소의 정확한 이름/상호명은 본문과 해시태그 어디에도 절대 넣지 마. 궁금증을 유발하는 티저 스타일로.
2. 지역(시/구 단위)은 힌트로 언급해도 됨. (예: "부산 어느 골목의...")
3. 자연스럽고 사람 냄새 나는 톤으로 써. 광고 문구 같은 뻔한 표현("인생맛집", "핫플 인정")은 피하고, 실제로 다녀와 본 사람이 소개하듯 3~5문장. 반드시 **친근하지만 정중한 존댓말(해요체)** 로 써. 반말 금지. 이모지는 2~4개만 적당히.
4. 여러 장의 사진이 함께 올라가는 게시물이야. 자연스러우면 사진 얘기(분위기, 디테일)를 한두 개 녹여도 좋아.
5. 마지막에 반드시 이 안내를 자연스럽게 포함: 댓글에 "${keyword()}"라고 남기고 팔로우하면 DM으로 위치를 보내준다는 것. (딱딱하지 않게)
6. 해시태그는 줄바꿈 후 8~12개: 분위기·음식종류·지역·감성 키워드 위주. 상호명/정확한 장소명 해시태그는 절대 금지.

캡션 본문과 해시태그만 출력해. 설명이나 따옴표 없이 바로 캡션만.`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          maxOutputTokens: 1200,
          // flash-latest는 thinking 모델이라 추론에 토큰을 다 써 캡션이 잘림 → thinking 끔
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
      signal: AbortSignal.timeout(30000),
    }
  );
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}: ${await res.text()}`);
  const json = await res.json();
  const cand = json?.candidates?.[0];
  const text: string = (cand?.content?.parts?.map((p: any) => p.text ?? "").join("") ?? "").trim();

  // 안전장치: 응답이 잘렸거나(MAX_TOKENS) 규칙 위반이면 템플릿으로 폴백
  const truncated = cand?.finishReason && cand.finishReason !== "STOP";
  const missingKeyword = !text.includes(keyword());
  const missingHashtag = !text.includes("#");
  const leakedName = text.includes(spot.name);
  if (!text || truncated || missingKeyword || missingHashtag || leakedName) {
    return generateWithTemplate(spot);
  }

  return { caption: `${text}\n\n${SOURCE_LINE}` };
}

// ===== 2순위: 템플릿 폴백 (LLM 없이 완전 무료·무의존) =====

const FOOD_OPENERS = [
  "{region} 골목 안쪽에 이런 데가 있더라고요 🤫 아는 사람만 조용히 다닌다는 곳이에요.",
  "{region} 갔다가 우연히 들어갔는데, 완전 취향저격이었어요 🍽️",
  "요즘 {region}에서 조용히 입소문 타는 중이라는 그 집이에요. 사진 보시면 왜인지 아실 거예요 😋",
  "{region} 오시면 여기는 그냥 지나치기 아까워요. 분위기부터 남다르더라고요 ✨",
  "저장해두고 {region} 가실 때 꼭 들러보시라고 아껴둔 곳이에요 📌",
];
const TRAVEL_OPENERS = [
  "{region}에 이런 데가 숨어있었네요. 사진으로 봐도 공기가 다른 느낌이에요 🌿",
  "주말에 어디 갈지 고민이시면, {region}의 여기 어떠세요? 사람도 아직 많이 없어요 📸",
  "{region} 현지인들이 조용히 아껴둔다는 장소예요. 왜 아껴두는지 알 것 같아요 ✨",
  "무심코 들렀다가 한참 머물렀던 {region}의 그곳이에요. 이런 뷰는 반칙이죠 🏞️",
  "{region} 드라이브 코스에 하나 추가해 보세요. 여기 진짜 저장각이에요 📌",
];
// 가끔 붙는 두 번째 문장 (자연스러움 강화)
const FOOD_LINES = [
  "메뉴 하나하나 정성이 느껴져서 또 생각날 것 같아요.",
  "웨이팅 있어도 납득되는 맛이랄까요.",
  "혼밥이든 모임이든 실패 없을 것 같아요.",
  "가격도 착해서 더 정드는 집이에요.",
];
const TRAVEL_LINES = [
  "노을 질 때 오면 진짜 예쁠 것 같아요.",
  "산책하듯 천천히 둘러보기 딱 좋아요.",
  "사진 찍기도 좋고 멍때리기도 좋고요.",
  "계절 바뀔 때마다 다른 느낌일 것 같아요.",
];
const FOOD_TAGS = ["맛집추천", "숨은맛집", "로컬맛집", "맛스타그램", "먹스타그램", "미식여행", "현지인맛집", "맛집투어", "먹킷리스트", "동네맛집"];
const TRAVEL_TAGS = ["여행스타그램", "국내여행", "숨은명소", "여행추천", "풍경스타그램", "주말나들이", "감성여행", "사진맛집", "국내여행지", "드라이브코스"];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

const SIDO_SHORT: Record<string, string> = {
  서울특별시: "서울", 부산광역시: "부산", 대구광역시: "대구", 인천광역시: "인천",
  광주광역시: "광주", 대전광역시: "대전", 울산광역시: "울산", 세종특별자치시: "세종",
  경기도: "경기", 강원도: "강원", 강원특별자치도: "강원",
  충청북도: "충북", 충청남도: "충남", 전라북도: "전북", 전북특별자치도: "전북",
  전라남도: "전남", 경상북도: "경북", 경상남도: "경남",
  제주특별자치도: "제주", 제주도: "제주",
};
const VALID_SHORT = new Set(Object.values(SIDO_SHORT));

/**
 * 주소에서 "서울 성북구" 같은 지역 힌트 추출 (상호명 노출 없음).
 * 알려진 시/도가 아니면(비정상 주소) 빈 문자열 반환 → 지역 태그/힌트 생략.
 */
function regionHint(address: string): { region: string; sido: string; gu: string } {
  const parts = address.split(/\s+/);
  const sido = SIDO_SHORT[parts[0] ?? ""] ?? "";
  if (!VALID_SHORT.has(sido)) return { region: "", sido: "", gu: "" };
  const gu = /(구|시|군)$/.test(parts[1] ?? "") ? parts[1] : "";
  return { region: [sido, gu].filter(Boolean).join(" "), sido, gu };
}

function generateWithTemplate(spot: Spot): CaptionResult {
  const { region, sido, gu } = regionHint(spot.address);
  const isFood = spot.category === "맛집";
  // region이 있으면 "{region}"에 지역명, 없으면 자연스러운 일반 표현으로 대체
  const opener = pick(isFood ? FOOD_OPENERS : TRAVEL_OPENERS).replace(
    "{region}",
    region || "요즘 뜨는 이 동네"
  );
  const line = pick(isFood ? FOOD_LINES : TRAVEL_LINES);

  // 유효한 시/도·구 단위만 해시태그로 (비정상 주소면 지역 태그 생략)
  const regionTags = [sido, gu]
    .filter(Boolean)
    .flatMap((r) => [`${r}${isFood ? "맛집" : "여행"}`, `${r}핫플`]);
  const tags = [...new Set([...regionTags, ...(isFood ? FOOD_TAGS : TRAVEL_TAGS)])]
    .slice(0, 12)
    .map((t) => `#${t.replace(/\s+/g, "")}`)
    .join(" ");

  const caption =
    `${opener} ${line}\n\n` +
    `어디인지 궁금하시면 댓글에 "${keyword()}" 남기고 팔로우해 주세요 🙌\n` +
    `위치는 DM으로 살짝 보내드릴게요 📩\n\n` +
    `${tags}\n\n${SOURCE_LINE}`;

  return { caption };
}

/** 댓글 키워드에 응답하는 DM 본문 */
export function buildDmText(spot: {
  place_name: string;
  address: string | null;
  category: string | null;
}): string {
  return (
    `안녕하세요! 궁금해하셨던 ${spot.category ?? "장소"} 알려드릴게요 🤫\n\n` +
    `📍 ${spot.place_name}\n` +
    (spot.address ? `🗺️ ${spot.address}\n` : "") +
    `\n좋은 시간 보내세요! 다음 장소도 기대해 주세요 💛\n` +
    `(정보 출처: 한국관광공사)`
  );
}
