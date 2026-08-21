import type { Spot } from "./tourapi";
import { FOOD_KEYWORDS } from "./tourapi";
import { llmText } from "./llm";
import persona from "@/data/persona.json";

const SOURCE_LINE = "📷 사진·정보 출처: 한국관광공사 TourAPI";

export interface CaptionResult {
  caption: string; // 해시태그 포함 완성본
}

/**
 * 공개형 맛집 캡션 + 해시태그 생성 (상호명·지역 공개, DM 유도 없음).
 * Gemini → Groq 폴백 체인 사용. 모두 실패하면 null (발행 건너뜀 — 템플릿 폴백 없음).
 */
export interface CaptionOpts {
  /** 인증·유명 맛집 사실 문구 (예: "미쉐린 가이드에 이름을 올린 적 있는 곳으로 알려져 있어요") */
  featuredBy?: string;
  /** 사진 출처 라인 교체 (예: 위키미디어 CC 크레딧). 없으면 TourAPI 출처. */
  sourceLine?: string;
  /** 대표 메뉴 (정보 고도화·저장 유발용, 위치 아님) */
  menu?: string;
  /** 영업시간 */
  hours?: string;
}

/**
 * 캡션 생성 — Gemini→Groq 폴백 체인. 모든 AI 실패/규칙위반 시 null 반환
 * → 호출부는 저품질 발행 대신 이번 회차를 건너뜀 (사용자 정책).
 */
export async function generateCaption(spot: Spot, opts: CaptionOpts = {}): Promise<CaptionResult | null> {
  try {
    return await generateWithGemini(spot, opts);
  } catch (e) {
    console.error("[caption] 생성 실패 — 발행 건너뜀 대상:", String(e).slice(0, 120));
    return null;
  }
}

// ===== LLM 캡션 생성 (Gemini → Groq 폴백은 lib/llm.ts에서 처리) =====

async function generateWithGemini(spot: Spot, opts: CaptionOpts = {}): Promise<CaptionResult> {
  const dish = dishOf(spot.name); // 음식 종류(검색 노출·해시태그용)
  const name = cleanName(spot.name);
  const { sido, gu } = regionHint(spot.address);
  const regionText = [sido, gu].filter(Boolean).join(" ");
  const featuredRule = opts.featuredBy
    ? `\n- ⭐이 집의 특별한 사실: "${opts.featuredBy}". 첫 문장 훅으로 활용해. 과장하거나 공식 제휴처럼 보이게 하지 말고 사실만 언급.`
    : "";
  const seoRule = dish
    ? `\n- 검색 노출을 위해 본문에 '${dish}'라는 음식 이름을 자연스럽게 1~2번 넣어줘.`
    : "";
  const menuRule = opts.menu
    ? `\n- 이 집 대표 메뉴는 "${opts.menu}"야. 본문에 이 메뉴 얘기를 자연스럽게 한 번 녹여줘 (맛 묘사).`
    : "";
  const prompt = `너는 인스타그램 맛집 계정 '${persona.name}'이야. ${persona.tagline}
이 캐릭터로 게시글 '본문'을 한국어로 써줘. (해시태그는 넣지 마 — 내가 따로 붙일 거야)

캐릭터 말투·시선:
${persona.captionStyle.map((s: string) => `- ${s}`).join("\n")}

가게 정보:
- 상호명: ${name}
- 위치: ${spot.address}
- 설명: ${spot.overview || "(설명 없음 — 사진 분위기로 작성)"}

작성 규칙:
1. ⭐상호명 "${name}"을 본문에 자연스럽게 넣어줘. 어디에 있는 곳인지(${regionText || "지역"})도 자연스럽게 언급해. 정보를 숨기지 말고 친절하게 소개하는 톤.
2. 3~5문장. 이모지는 2~4개만 적당히.
3. 사진과 함께 올라가는 게시물이야. 자연스러우면 음식 얘기(맛, 비주얼)를 한두 개 녹여도 좋아.
4. 마지막은 저장·방문을 부드럽게 권하는 한 문장으로 마무리해. 댓글로 위치를 물어보라거나 DM을 보내준다는 안내는 절대 넣지 마.
5. ⚠️해시태그(#)는 절대 넣지 마. 본문 문장만 출력해.
6. ⚠️반드시 순수 한글로만 써. 한자(漢字)나 중국어 문자를 절대 섞지 마.${seoRule}${menuRule}${featuredRule}

캡션 본문만 출력해. 설명이나 따옴표 없이 바로 본문만.`;

  const r = await llmText(prompt, { maxTokens: 1000 });
  if (!r) throw new Error("모든 AI 소진 (Gemini/Groq)");
  const body = r.text.replace(/#[^\s#]+/g, "").trim(); // 혹시 나온 해시태그는 제거(내가 붙임)
  if (!body) throw new Error(`빈 캡션 (provider=${r.provider})`);

  // 품질 게이트: 일부 모델(Groq llama 등)이 한국어에 한자를 섞어 쓰는 경우가 있다
  // ("옹기宿성", "풍味"). 이런 캡션은 발행하지 않고 건너뛴다.
  if (/[一-鿿]/.test(body)) {
    throw new Error(`한자 혼입 캡션 (provider=${r.provider}) — 발행 건너뜀`);
  }
  // 상호명이 본문에 빠졌으면 소개글로서 부실 — 발행하지 않음
  if (!body.replace(/\s+/g, "").includes(name.replace(/\s+/g, ""))) {
    throw new Error(`상호명 누락 캡션 (provider=${r.provider}) — 발행 건너뜀`);
  }

  // 정보 블록 — 상호·위치를 공개하는 정보형 게시물
  const infoLines = [
    `📍 ${name}${regionText ? ` (${regionText})` : ""}`,
    opts.menu ? `📋 대표 메뉴 · ${opts.menu}` : "",
    opts.hours ? `⏰ ${opts.hours}` : "",
  ].filter(Boolean);
  const infoBlock = `${infoLines.join("\n")}\n\n`;

  return { caption: `${body}\n\n${infoBlock}${buildHashtags(spot, dish, opts.menu)}\n\n${SOURCE_LINE}` };
}

/**
 * 릴스 첫 화면(텍스트 훅 카드)에 띄울 강렬한 한 줄.
 * 사진 퀄리티에 기대지 않고 '문구'로 스크롤을 멈추게 하는 게 목적.
 * 실패하면 null → 호출부가 기본 훅으로 대체.
 */
export async function generateHook(spot: Spot, opts: { menu?: string } = {}): Promise<string | null> {
  const name = cleanName(spot.name);
  const { sido, gu } = regionHint(spot.address);
  const prompt = `인스타 릴스 첫 화면에 크게 띄울 '훅 문구' 하나만 만들어줘.
스크롤을 멈추고 "이게 뭔데?" 하고 끝까지 보게 만드는 게 목적이야.

가게: ${name} (${[sido, gu].filter(Boolean).join(" ") || "지역"})
${opts.menu ? `대표 메뉴: ${opts.menu}` : ""}
설명: ${(spot.overview || "").slice(0, 500) || "(없음)"}

⭐가장 중요한 원칙: 설명하지 말고 내지르듯이. 릴스에서 통하는 짧고 센 감탄.
점잖은 문장은 아무도 안 멈춘다. 유행어·감탄사 환영.
  나쁨: 경주 밀면 노포의 깊은 맛  (설명문, 안 멈춤)
  나쁨: 한우 뼈 육수 안 먹어봤으면 손해입니다  (서술형 문장, 김빠짐)
  좋음: 3일 우린 육수 미쳤다  (짧고 셈)
  좋음: 돈까스에 쫄면 조합 실화?  (짧고 셈)

아래 패턴 중 이 가게에 가장 어울리는 하나를 골라 써:
1) 감탄 폭발 — "육수부터 미쳤다", "겉바속촉 그 자체"
2) 끝판왕 선언 — "경주 밀면 끝판왕", "국밥 근본 그 자체", "돈까스 원탑"
3) 실화 반문 — "이 가격에 이 비주얼 실화?", "메뉴 하나로 30년 실화?"
4) 숫자 임팩트 — "육수에만 3일", "하루 200그릇 완판", "30년 줄 서는 집"
5) 역대급 조합 — "역대급 국물 클라스", "웨이팅 역대급인 골목집"

규칙:
- 6~18자. 딱 한 줄. 짧을수록 좋다.
- ⛔ 서술형 종결 금지: "~습니다", "~해요", "~겁니다", "~마세요", "~네요"로 끝내지 마.
  명사·감탄·반문("~실화?", "~미쳤다", "~끝판왕", "~그 자체")으로 끝내.
- ⛔ "이유"라는 단어 금지 ("~하는 이유", "이유가 있습니다" 전부). 너무 흔한 공식.
- 위 설명에 실제로 있는 사실(연식·단일메뉴·조리법·규모·재료·단골)이 있으면 그걸 세게 키워.
  없으면 음식 자체의 강렬한 한 방(식감·국물·불맛)으로.
- 없는 사실을 지어내지는 마 (숫자·연식·수상 이력 등은 설명에 있는 것만).
- 이모지·해시태그·따옴표 금지. 순수 한글(한자 금지). 상호명은 넣지 마(아래 부제에 따로 나옴).

문구 한 줄만 출력해.`;

  // 금지 스타일은 프롬프트에서 막았지만 모델이 습관처럼 내는 경우가 있어
  // (서술형 종결·"이유" 공식 모두 학습이 깊다) 걸리면 한 번 더 요청한다.
  const BAD_ENDING = /(습니다|합니다|입니다|어요|아요|해요|예요|세요|네요|겁니다|됩니다)\s*[.!?]?$/;
  for (let attempt = 0; attempt < 2; attempt++) {
    const p =
      attempt === 0
        ? prompt
        : prompt + "\n\n⛔ 방금 서술형 문장이 나왔다. 더 짧게, 명사·감탄·반문으로 끝내라. 예: 육수부터 미쳤다";
    const r = await llmText(p, { maxTokens: 100 });
    if (!r) return null;
    const line = r.text.split("\n")[0].replace(/[#"'`]/g, "").trim();
    if (!line || line.length < 5 || line.length > 26) return null;
    if (/[一-鿿]/.test(line)) return null;
    if (line.includes("이유") || BAD_ENDING.test(line)) continue; // 금지 스타일 → 재시도
    return line;
  }
  return null;
}

/**
 * 릴스 나레이션 스크립트 — 캐릭터 톤의 짧은 문장 배열.
 * 각 문장이 릴스의 한 컷(자막 + 음성)에 대응한다.
 * 실패하면 null → 호출부는 음성 없이 진행(무음 릴스로 폴백).
 */
export async function generateNarration(
  spot: Spot,
  opts: { menu?: string; lines?: number } = {}
): Promise<string[] | null> {
  const name = cleanName(spot.name);
  const { sido, gu } = regionHint(spot.address);
  const want = Math.min(Math.max(opts.lines ?? 4, 3), 5);
  const prompt = `너는 인스타그램 맛집 계정 '${persona.name}'이야. ${persona.tagline}
아래 가게를 소개하는 릴스 나레이션 대본을 써줘.

가게: ${name} (${[sido, gu].filter(Boolean).join(" ") || "지역"})
${opts.menu ? `대표 메뉴: ${opts.menu}` : ""}
설명: ${(spot.overview || "").slice(0, 400) || "(없음)"}

대본 규칙:
${persona.narrationStyle.map((s: string) => `- ${s}`).join("\n")}
- 정확히 ${want}문장. 각 문장은 한 줄로.
- ⭐짧고 강하게. 문장마다 다른 이야기를 하고, 설명을 늘어놓지 마. 흐름:
  훅(궁금증) → 어디 무슨 집인지 → 맛의 한 방 → 저장·방문 권유 마무리
- 각 문장 12~24자. 길면 지루해서 넘긴다.
- 말로 읽을 문장이니 해시태그·이모지·괄호·따옴표는 절대 넣지 마.
- 순수 한글로만 써. 한자 금지. 숫자는 한글로 풀어 쓰지 말고 그대로 (예: 30년).
- 상호명 "${name}"을 첫 문장이나 두 번째 문장에 넣어줘.
- 존댓말 해요체. 과장 광고 표현 금지.

문장만 줄바꿈으로 구분해 출력해. 번호·기호 없이.`;

  const r = await llmText(prompt, { maxTokens: 500 });
  if (!r) return null;
  const lines = r.text
    .split("\n")
    .map((l) => l.replace(/^[\d.\-•*)\s]+/, "").replace(/[#"'`()]/g, "").trim())
    .filter((l) => l.length >= 4 && l.length <= 60);
  if (lines.length < 2) return null;
  if (lines.some((l) => /[一-鿿]/.test(l))) return null; // 한자 혼입 시 음성 생략
  return lines.slice(0, want);
}

/** 게시물명에서 음식 종류 추출 (SEO 본문·해시태그용) */
function dishOf(placeName: string): string | null {
  for (const kw of FOOD_KEYWORDS) if (placeName.includes(kw)) return kw;
  return null;
}

/** TourAPI 상호명 정리 — 대괄호 태그([백년가게] 등) 제거 */
function cleanName(name: string): string {
  return String(name).replace(/\[[^\]]*\]/g, "").trim();
}

/**
 * 해시태그 전략 — 도달·검색 노출 최적화 (공개형).
 * 상호명 태그 + 지역×음식 조합 + 메뉴 + 상황 태그를 섞어 구체적으로 만든다.
 * 초대형 단일 태그(#맛집)에만 의존하면 묻히므로 조합형·니치 위주.
 */
function buildHashtags(spot: Spot, dish: string | null, menu?: string): string {
  const { sido, gu } = regionHint(spot.address);
  const tags: string[] = [];

  // ① 상호명 (가장 구체적 — 검색으로 이 가게를 찾는 사람에게 직접 닿음)
  const nameTag = cleanName(spot.name).replace(/\s+/g, "");
  if (nameTag.length >= 2) tags.push(nameTag);

  // ② 지역 × 음식 조합 (구체적 검색어와 정확히 일치)
  if (gu) {
    tags.push(`${gu}맛집`);
    if (dish) tags.push(`${gu}${dish}`, `${gu}${dish}맛집`);
    tags.push(`${gu}맛집추천`, `${gu}가볼만한곳`);
  }
  if (sido) {
    tags.push(`${sido}맛집`);
    if (dish) tags.push(`${sido}${dish}`, `${sido}${dish}맛집`);
    tags.push(`${sido}맛집투어`, `${sido}가볼만한곳`);
  }

  // ③ 음식 종류
  if (dish) tags.push(dish, `${dish}맛집`, `${dish}추천`, `${dish}전문점`);

  // ④ 대표 메뉴 (첫 메뉴만 — 매우 구체적인 검색어)
  const firstMenu = String(menu ?? "").split(",")[0].replace(/\s+/g, "").replace(/[()]/g, "");
  if (firstMenu.length >= 2 && firstMenu.length <= 12) tags.push(firstMenu);

  // ⑤ 상황·큐레이션 태그
  tags.push(
    "맛집추천", "로컬맛집", "노포맛집", "맛집탐방", "맛스타그램", "먹스타그램",
    "오늘뭐먹지", "먹킷리스트", "맛집저장", "국내맛집"
  );

  // 중복 제거 + 개수 제한(28 — 인스타 권장 30 이하) + # 접두
  return [...new Set(tags)]
    .filter((t) => t && t.length >= 2)
    .slice(0, 28)
    .map((t) => `#${t.replace(/\s+/g, "")}`)
    .join(" ");
}

/** 주소에서 지역 태그용 시/도 축약형·시군구 추출 (비정상 주소면 빈 값) */
function regionHint(address: string): { sido: string; gu: string } {
  const parts = (address ?? "").split(/\s+/);
  const sido = SIDO_SHORT[parts[0] ?? ""] ?? "";
  if (!sido) return { sido: "", gu: "" };
  let gu = /(구|시|군)$/.test(parts[1] ?? "") ? (parts[1] as string) : "";
  // 해시태그 탐색량을 위해 접미사 제거(강남구→강남). 단 제거 후 1글자가 되면(중구→중)
  // 모호해지므로 원형 유지.
  const guBase = gu.replace(/(구|시|군)$/, "");
  if (guBase.length >= 2) gu = guBase;
  return { sido, gu };
}

const SIDO_SHORT: Record<string, string> = {
  서울특별시: "서울", 부산광역시: "부산", 대구광역시: "대구", 인천광역시: "인천",
  광주광역시: "광주", 대전광역시: "대전", 울산광역시: "울산", 세종특별자치시: "세종",
  경기도: "경기", 강원도: "강원", 강원특별자치도: "강원",
  충청북도: "충북", 충청남도: "충남", 전라북도: "전북", 전북특별자치도: "전북",
  전라남도: "전남", 경상북도: "경북", 경상남도: "경남",
  제주특별자치도: "제주", 제주도: "제주",
};
/** 댓글 키워드에 응답하는 DM 본문 (+근처 추천 보너스) */
export function buildDmText(
  spot: {
    place_name: string;
    address: string | null;
    category: string | null;
    featured_by?: string | null;
    map_url?: string | null;
  },
  nearby: { name: string; address: string; category: string; distM: number }[] = []
): string {
  let text =
    `안녕하세요! 궁금해하셨던 ${spot.category ?? "장소"} 알려드릴게요 🤫\n\n` +
    `📍 ${spot.place_name}\n` +
    (spot.address ? `🗺️ ${spot.address}\n` : "") +
    (spot.featured_by ? `🏅 ${spot.featured_by}\n` : "") +
    (spot.map_url ? `🧭 길찾기: ${spot.map_url}\n` : "");

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

/**
 * 내 사진(직접 촬영) 게시용 캡션 — 상호명 공개, 직접 방문 후기 톤.
 * TourAPI 출처 라인 없음(내 사진). Gemini 있으면 메모를 자연스럽게 살림.
 */
export async function generateMyCaption(input: {
  name: string;
  region: string;
  category: string;
  note?: string;
  mapUrl?: string;
}): Promise<string> {
  const { name, region, category, note, mapUrl } = input;
  let body = "";

  const prompt = `인스타 ${category} 소개 게시글 캡션 본문을 써줘.
- 상호명: ${name} (${region})
- 직접 다녀와서 찍은 사진이야
- 참고 메모: ${note || "(없음 — 분위기 좋게 소개)"}
규칙: 친근한 존댓말(해요체) 3~4문장, 실제 다녀온 사람 톤, 상호명 자연스럽게 언급, 과장 금지, 이모지 2~3개. 해시태그·안내문구 없이 본문만.`;
  const r = await llmText(prompt, { maxTokens: 700 });
  if (r) body = r.text;
  if (!body) {
    // 내 사진 게시물은 사용자가 쓴 메모가 있으므로 AI 없이도 발행 (사용자 문구 = 저품질 아님)
    body = note
      ? `${note}\n\n직접 다녀온 ${category}, ${name} 다녀왔어요 📸`
      : `직접 다녀온 ${category} ${name}, 사진으로 남겨봐요 📸 분위기도 좋고 또 가고 싶은 곳이에요.`;
  }

  const isFood = category === "맛집";
  const rParts = region.split(/\s+/).filter(Boolean);
  const regionTags = rParts.flatMap((r) => [`#${r}${isFood ? "맛집" : "여행"}`, `#${r}핫플`]);
  const baseTags = isFood
    ? ["#맛집추천", "#먹스타그램", "#맛스타그램", "#직접다녀온맛집", "#내돈내산"]
    : ["#여행스타그램", "#국내여행", "#여행추천", "#감성여행", "#직접다녀온곳"];
  const tags = [...new Set([...regionTags, ...baseTags])].slice(0, 12).join(" ");

  return (
    `${body}\n\n` +
    `📍 ${name} (${region})\n` +
    (mapUrl ? `🧭 위치: ${mapUrl}\n` : "") +
    `\n${tags}`
  );
}

/**
 * 위키미디어 여행지 게시용 캡션 — 장소명 공개, 여행 소개 톤 + CC 사진 출처 표기.
 */
export async function generateLandmarkCaption(spot: Spot, credit: string): Promise<string | null> {
  const { name, address: region } = spot;
  const prompt = `인스타 여행 소개 게시글 본문을 써줘.
- 장소: ${name} (${region})
규칙: 친근한 존댓말(해요체) 3~4문장, 이 여행지의 매력·볼거리·분위기를 소개. 장소명 자연스럽게 언급. 과장·허위 금지, 실제로 유명한 곳이니 일반적으로 알려진 특징 위주. 이모지 2~3개. 해시태그·안내문구 없이 본문만.`;
  const r = await llmText(prompt, { maxTokens: 700 });
  if (!r) return null; // 모든 AI 소진 → 이번 게시물 건너뜀
  const body = r.text;

  const rTags = region.split(/\s+/).filter(Boolean).flatMap((r) => [`#${r}여행`, `#${r}가볼만한곳`]);
  const tags = [...new Set([...rTags, "#국내여행", "#여행스타그램", "#여행에미치다", "#여행추천", "#풍경스타그램", "#여행에미치다"])]
    .slice(0, 11)
    .join(" ");

  return `${body}\n\n📍 ${name} (${region})\n\n${tags}\n\n${credit}`;
}

/** 주간 베스트 TOP3 게시물 캡션 (공개형 — 상호·위치는 슬라이드/본문에 공개) */
export function buildWeeklyCaption(count: number): string {
  return (
    `🔥 이번 주 여러분이 가장 사랑해주신 TOP${count}를 모아봤어요!\n\n` +
    `좋아요와 댓글이 가장 뜨거웠던 맛집들이에요.\n` +
    `저장해두고 하나씩 가보시면 후회 없으실 거예요 😋\n\n` +
    `#주간베스트 #맛집추천 #맛집리스트 #맛집저장 #먹스타그램 #맛스타그램 #오늘뭐먹지 #국내맛집\n\n` +
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
