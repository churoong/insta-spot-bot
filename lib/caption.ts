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

장소 정보(캡션에 위치를 드러내지 않기 위한 참고용, 아래 정보로 분위기만 파악):
- 이름: ${spot.name} (절대 캡션에 쓰지 말 것!)
- 주소: ${spot.address} (지역명 노출 금지, 분위기 파악용)
- 분류: ${spot.category}
- 설명: ${spot.overview || "(설명 없음 — 사진 분위기로 작성)"}

작성 규칙:
1. 장소의 정확한 이름/상호명은 본문과 해시태그 어디에도 절대 넣지 마. 궁금증을 유발하는 티저 스타일로.
2. ⭐가장 중요: 위치를 추측할 수 있는 그 어떤 힌트도 넣지 마. 시/도/시군구/동/읍면 등 지역명, 유명 거리·랜드마크·역 이름, 지역 특산·방언 등 어디인지 짐작하게 하는 표현 전부 금지. 위치는 비밀이고 오직 DM으로만 알려줄 거야. (예: "부산", "서면", "제주" 같은 단어 금지)
3. 자연스럽고 사람 냄새 나는 톤으로 써. 광고 문구 같은 뻔한 표현("인생맛집", "핫플 인정")은 피하고, 실제로 다녀와 본 사람이 소개하듯 3~5문장. 반드시 **친근하지만 정중한 존댓말(해요체)** 로 써. 반말 금지. 이모지는 2~4개만 적당히.
4. 여러 장의 사진이 함께 올라가는 게시물이야. 자연스러우면 사진 얘기(분위기, 디테일)를 한두 개 녹여도 좋아.
5. 마지막에 반드시 이 안내를 자연스럽게 포함: 댓글에 "${keyword()}"라고 남기고 팔로우하면 DM으로 위치를 보내준다는 것. (딱딱하지 않게)
6. 해시태그는 줄바꿈 후 8~12개: 분위기·음식종류·감성 키워드 위주. 상호명·정확한 장소명은 물론 지역명(지명) 해시태그도 절대 금지. (#부산맛집, #제주여행 같은 지역 태그 금지)

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
  const leakedLocation = leaksLocation(text, spot.address);
  if (!text || truncated || missingKeyword || missingHashtag || leakedName || leakedLocation) {
    return generateWithTemplate(spot);
  }

  return { caption: `${text}\n\n${SOURCE_LINE}` };
}

/** 캡션에 주소의 지역명(시/도/구/동/거리)이 새어나갔는지 검사 */
function leaksLocation(text: string, address: string): boolean {
  const parts = address.split(/\s+/).slice(0, 3);
  const terms = new Set<string>();
  for (const p of parts) {
    const stripped = p.replace(
      /(특별자치도|특별자치시|특별시|광역시|자치도|자치시|도|시|군|구|읍|면|동|리|로|길|가|번길)$/g,
      ""
    );
    if (stripped.length >= 2) terms.add(stripped);
  }
  const short = SIDO_SHORT[parts[0] ?? ""];
  if (short) terms.add(short);
  for (const t of terms) if (t && text.includes(t)) return true;
  return false;
}

// ===== 2순위: 템플릿 폴백 (LLM 없이 완전 무료·무의존) =====

// 지역명 노출 금지 — 위치는 DM으로만. 오프너에 지역 힌트 없음.
const FOOD_OPENERS = [
  "골목 안쪽에 이런 데가 있더라고요 🤫 아는 사람만 조용히 다닌다는 곳이에요.",
  "우연히 들어갔다가 완전 취향저격이었어요 🍽️ 이런 곳은 아껴두고 싶더라고요.",
  "요즘 조용히 입소문 타는 중이라는 그 집이에요. 사진 보시면 왜인지 아실 거예요 😋",
  "그냥 지나치기 아까운 곳이에요. 분위기부터 남다르더라고요 ✨",
  "저장해두고 꼭 다시 가보려고 아껴둔 곳이에요 📌",
];
const TRAVEL_OPENERS = [
  "이런 데가 숨어있었네요. 사진으로 봐도 공기가 다른 느낌이에요 🌿",
  "주말에 어디 갈지 고민이시면 여기 어떠세요? 사람도 아직 많이 없어요 📸",
  "현지인들이 조용히 아껴둔다는 장소예요. 왜 아껴두는지 알 것 같아요 ✨",
  "무심코 들렀다가 한참 머물렀던 그곳이에요. 이런 뷰는 반칙이죠 🏞️",
  "다음 나들이 코스에 하나 추가해 보세요. 여기 진짜 저장각이에요 📌",
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
function generateWithTemplate(spot: Spot): CaptionResult {
  const isFood = spot.category === "맛집";
  // 지역명 노출 금지 — 오프너는 이미 지역 힌트 없음
  const opener = pick(isFood ? FOOD_OPENERS : TRAVEL_OPENERS);
  const line = pick(isFood ? FOOD_LINES : TRAVEL_LINES);

  // 지역(지명) 해시태그 없이 분위기·감성 태그만 사용
  const tags = (isFood ? FOOD_TAGS : TRAVEL_TAGS)
    .slice(0, 10)
    .map((t) => `#${t.replace(/\s+/g, "")}`)
    .join(" ");

  const caption =
    `${opener} ${line}\n\n` +
    `어디인지 궁금하시면 댓글에 "${keyword()}" 남기고 팔로우해 주세요 🙌\n` +
    `위치는 DM으로 살짝 보내드릴게요 📩\n\n` +
    `${tags}\n\n${SOURCE_LINE}`;

  return { caption };
}

/** 댓글 키워드에 응답하는 DM 본문 (+근처 추천 보너스) */
export function buildDmText(
  spot: {
    place_name: string;
    address: string | null;
    category: string | null;
  },
  nearby: { name: string; address: string; category: string; distM: number }[] = []
): string {
  let text =
    `안녕하세요! 궁금해하셨던 ${spot.category ?? "장소"} 알려드릴게요 🤫\n\n` +
    `📍 ${spot.place_name}\n` +
    (spot.address ? `🗺️ ${spot.address}\n` : "");

  if (nearby.length > 0) {
    text += `\n🚶 근처에 이런 곳도 있어요!\n`;
    for (const n of nearby) {
      const dist = n.distM >= 1000 ? `${(n.distM / 1000).toFixed(1)}km` : `${n.distM}m`;
      text += `• ${n.name} (${n.category} · 약 ${dist})\n`;
    }
  }

  text +=
    `\n좋은 시간 보내세요! 다음 장소도 기대해 주세요 💛\n` +
    `(정보 출처: 한국관광공사)`;
  return text;
}

/** 릴스용 캡션 (짧고 강한 훅 + 위치 비공개 + DM 유도) */
export function buildReelCaption(category: string): string {
  const hook =
    category === "맛집"
      ? "이 집, 사진만 봐도 군침 도시죠? 🤤"
      : "여기 진짜 실화냐는 소리 나오는 곳이에요 😳";
  return (
    `${hook}\n\n` +
    `끝까지 보시면 왜 다들 저장하는지 아실 거예요 👀\n` +
    `어디인지 궁금하시면 댓글에 "${keyword()}" 남기고 팔로우해 주세요 🙌\n` +
    `위치는 DM으로 살짝 보내드릴게요 📩\n\n` +
    `#릴스 #reels #국내여행 #맛집추천 #여행에미치다 #숨은명소 #저장각 #여행스타그램 #먹스타그램 #여행릴스\n\n` +
    SOURCE_LINE
  );
}

/** 주간 베스트 TOP3 게시물 캡션 (장소명 비공개 유지 — 위치는 DM으로) */
export function buildWeeklyCaption(count: number): string {
  return (
    `🔥 이번 주 여러분이 가장 사랑해주신 TOP${count}를 모아봤어요!\n\n` +
    `좋아요와 댓글이 가장 뜨거웠던 곳들이에요. 다들 어디인지 눈치채셨을까요? 🤭\n` +
    `아직 위치를 못 받으신 분들은 지금이 기회예요.\n\n` +
    `궁금하신 분은 댓글에 "${keyword()}" 남기고 팔로우해 주세요 🙌\n` +
    `TOP${count} 전부 DM으로 몰아서 보내드릴게요 📩\n\n` +
    `#주간베스트 #이주의명소 #맛집추천 #여행추천 #숨은명소 #저장각 #먹스타그램 #여행스타그램\n\n` +
    SOURCE_LINE
  );
}

// 댓글에 다는 공개 대댓글 — "DM으로 보내드릴게요" 안내 (자연스럽게, 이모지 포함)
const REPLY_TEMPLATES = [
  '궁금하셨죠? 방금 위치를 DM으로 살짝 보내드렸어요! 확인해 보세요 🤫💌',
  '넵! 어디인지 DM으로 콕 찍어 보내드렸어요 📩 맛있게(즐겁게) 다녀오세요 😊',
  '위치 정보 DM으로 쏙 넣어드렸어요! 팔로우해두시면 다음 장소도 놓치지 않으실 거예요 🙌✨',
  '기다리셨죠? 방금 DM으로 위치 보내드렸으니 메시지함 확인해 주세요 💌😉',
  '오케이! DM으로 자세한 위치 보내드렸어요 📍 좋은 시간 보내세요 💛',
];

export function buildReplyText(): string {
  return REPLY_TEMPLATES[Math.floor(Math.random() * REPLY_TEMPLATES.length)];
}
