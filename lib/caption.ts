import type { Spot } from "./tourapi";
import { FOOD_KEYWORDS } from "./tourapi";
import { llmText } from "./llm";

const SOURCE_LINE = "📷 사진·정보 출처: 한국관광공사 TourAPI";

export interface CaptionResult {
  caption: string; // 해시태그 포함 완성본
}

function keyword() {
  return process.env.DM_KEYWORD || "어디야";
}

/**
 * 장소명을 숨긴 티저형 캡션 + 해시태그 생성.
 * Gemini → Groq 폴백 체인 사용. 모두 실패하면 null (발행 건너뜀 — 템플릿 폴백 없음).
 * 규칙: 상호명/정확한 장소명은 본문·해시태그 모두 금지,
 * 댓글 키워드 + 팔로우 → DM 안내 문구 포함, 출처 명시.
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
  const dish = dishOf(spot.name); // 음식 종류(검색 노출·해시태그용). 위치가 아니므로 본문 사용 OK.
  const featuredRule = opts.featuredBy
    ? `\n- ⭐이 집의 특별한 사실: "${opts.featuredBy}". 이 사실을 첫 문장 훅으로 강렬하게 활용해 (예: "미쉐린 가이드에 이름을 올렸던 그 집..."). 단, 과장하거나 공식 제휴처럼 보이게 하지 말고 사실만 언급. 상호명은 여전히 비밀.`
    : "";
  const seoRule = dish
    ? `\n- 검색 노출을 위해 본문에 '${dish}'라는 음식 이름을 자연스럽게 1~2번 넣어줘 (음식 종류이지 위치가 아니니 괜찮아).`
    : "";
  const menuRule = opts.menu
    ? `\n- 이 집 대표 메뉴는 "${opts.menu}"야. 본문에 이 메뉴 얘기를 자연스럽게 한 번 녹여줘 (먹어본 듯 맛 묘사). 메뉴명은 위치가 아니니 써도 돼.`
    : "";
  const prompt = `인스타그램 ${spot.category} 소개 계정의 게시글 '본문'을 한국어로 작성해줘. (해시태그는 넣지 마 — 내가 따로 붙일 거야)

장소 정보(본문에 위치를 드러내지 않기 위한 참고용, 아래 정보로 분위기만 파악):
- 이름: ${spot.name} (절대 캡션에 쓰지 말 것!)
- 주소: ${spot.address}
- 분류: ${spot.category}
- 설명: ${spot.overview || "(설명 없음 — 사진 분위기로 작성)"}

작성 규칙:
1. 장소의 정확한 이름/상호명은 절대 넣지 마. 궁금증을 유발하는 티저 스타일로.
2. ⭐본문에는 위치를 추측할 수 있는 어떤 힌트도 넣지 마. 시/도/시군구/동 등 지역명, 유명 거리·랜드마크·역 이름 전부 금지. 정확한 위치는 비밀이고 오직 DM으로만 알려줄 거야.
3. 자연스럽고 사람 냄새 나는 톤으로 써. 광고 문구 같은 뻔한 표현("인생맛집", "핫플 인정")은 피하고, 실제로 다녀와 본 사람이 소개하듯 3~5문장. 반드시 **친근하지만 정중한 존댓말(해요체)** 로 써. 반말 금지. 이모지는 2~4개만 적당히.
4. 여러 장의 사진이 함께 올라가는 게시물이야. 자연스러우면 사진 얘기(분위기, 디테일)를 한두 개 녹여도 좋아.
5. 마지막에 반드시 이 안내를 자연스럽게 포함: 댓글에 "${keyword()}"라고 남기고 팔로우하면 DM으로 위치를 보내준다는 것. (딱딱하지 않게)
6. ⚠️해시태그(#)는 절대 넣지 마. 본문 문장만 출력해.${seoRule}${menuRule}${featuredRule}

캡션 본문만 출력해. 설명이나 따옴표 없이 바로 본문만.`;

  const r = await llmText(prompt, { maxTokens: 1000 });
  if (!r) throw new Error("모든 AI 소진 (Gemini/Groq)");
  const body = r.text.replace(/#[^\s#]+/g, "").trim(); // 혹시 나온 해시태그는 제거(내가 붙임)

  // 안전장치: 규칙 위반이면 발행하지 않음 (템플릿 폴백 없음)
  const missingKeyword = !body.includes(keyword());
  // 상호명은 대괄호·공백 제거 후 비교 — "홍길동막국수[본점]"의 본체 "홍길동막국수"가
  // 본문에 나와도 잡아냄 (정확일치만 하면 브랜치·괄호 표기를 놓침).
  const nameCore = spot.name.replace(/\[[^\]]*\]/g, "").replace(/\s+/g, "");
  const leakedName =
    body.includes(spot.name) ||
    (nameCore.length >= 2 && body.replace(/\s+/g, "").includes(nameCore));
  const leakedLocation = leaksLocation(body, spot.address);
  if (!body || missingKeyword || leakedName || leakedLocation) {
    throw new Error(`캡션 규칙 위반 (provider=${r.provider}, keyword=${!missingKeyword}, name누출=${leakedName}, 위치누출=${leakedLocation})`);
  }

  // 정보 고도화 블록 — 저장 유발(메뉴·영업시간은 위치가 아니라 공개 OK)
  const infoLines = [
    opts.menu ? `📋 대표 메뉴 · ${opts.menu}` : "",
    opts.hours ? `⏰ ${opts.hours}` : "",
  ].filter(Boolean);
  const infoBlock = infoLines.length ? `${infoLines.join("\n")}\n\n` : "";

  return { caption: `${body}\n\n${infoBlock}${buildHashtags(spot, dish)}\n\n${SOURCE_LINE}` };
}

/** 게시물명에서 음식 종류 추출 (SEO 본문·해시태그용) */
function dishOf(placeName: string): string | null {
  for (const kw of FOOD_KEYWORDS) if (placeName.includes(kw)) return kw;
  return null;
}

/**
 * 해시태그 전략 — 도달·검색 노출 최적화.
 * 초대형 태그(#맛집)에 묻히지 않게 지역·음식·상황을 조합한 중간 규모/니치 태그 위주.
 */
function buildHashtags(spot: Spot, dish: string | null): string {
  const { sido, gu } = regionHint(spot.address);
  const tags: string[] = [];
  // 지역 (탐색·검색 유입)
  if (sido) {
    tags.push(`${sido}맛집`);
    if (gu) tags.push(`${gu}맛집`, `${gu}핫플`);
    tags.push(`${sido}맛집투어`, `${sido}가볼만한곳`);
  }
  // 음식 종류 (SEO — 검색이 캡션·태그를 인덱싱)
  if (dish) tags.push(dish, `${dish}맛집`, `${dish}추천`);
  // 큐레이션: 중간 규모 니치 + 상황 태그
  tags.push(
    "맛집추천", "숨은맛집", "로컬맛집", "맛집탐방", "맛스타그램", "먹스타그램",
    "오늘뭐먹지", "먹킷리스트", "존맛탱", "국내맛집", "맛집저장", "여기어때"
  );
  // 중복 제거 + 개수 제한(15) + # 접두
  return [...new Set(tags)]
    .slice(0, 15)
    .map((t) => `#${t.replace(/\s+/g, "")}`)
    .join(" ");
}

/** 본문에 주소의 지역명(시/도/구/동/거리)이 새어나갔는지 검사 */
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

/** 릴스용 캡션 (짧고 강한 훅 + 본문 위치 비공개 + 지역 태그 + DM 유도) */
export function buildReelCaption(category: string, address = ""): string {
  const hook =
    category === "맛집"
      ? "이 집, 사진만 봐도 군침 도시죠? 🤤"
      : "여기 진짜 실화냐는 소리 나오는 곳이에요 😳";
  const { sido, gu } = regionHint(address);
  const regionTags = [sido, gu]
    .filter(Boolean)
    .flatMap((r) => [`#${r}${category === "맛집" ? "맛집" : "여행"}`, `#${r}핫플`])
    .join(" ");
  return (
    `${hook}\n\n` +
    `끝까지 보시면 왜 다들 저장하는지 아실 거예요 👀\n` +
    `어디인지 궁금하시면 댓글에 "${keyword()}" 남기고 팔로우해 주세요 🙌\n` +
    `위치는 DM으로 살짝 보내드릴게요 📩\n\n` +
    `${regionTags ? regionTags + " " : ""}#릴스 #reels #국내여행 #맛집추천 #숨은명소 #저장각 #여행스타그램 #먹스타그램 #여행릴스\n\n` +
    SOURCE_LINE
  );
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
