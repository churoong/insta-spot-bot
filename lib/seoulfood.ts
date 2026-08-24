import fs from "node:fs";
import path from "node:path";
import type { Spot } from "./tourapi";

/**
 * 서울관광재단 음식관광 DB — TourAPI 밖의 두 번째 식당·사진 소스.
 *
 * 원본 API(레드테이블 OpenAPI)는 ID 필터·numOfRows를 무시하고 1000행 페이지만
 * 반환하므로 실시간 조회가 불가능하다. scripts/build-seoul-db.mjs가 전체를 훑어
 * "사진이 살아있는 식당"만 data/seoul-food.json으로 굳혀두고, 런타임은 그 파일만
 * 읽는다(토큰 불필요 — Vercel·Actions 어디서든 동작).
 *
 * 2021년 구축 데이터라 폐업 가게가 섞여 있을 수 있다 — 발행 파이프라인의
 * 블로그 후기 수 게이트(minBuzz)가 사실상의 생존 검증을 겸한다.
 */

// Vercel 번들에서는 import.meta.url이 .next 청크를 가리켜 상대 경로가 깨진다 — cwd 기준(폰트와 동일 방식)
const FILE = path.join(process.cwd(), "data", "seoul-food.json");

// 순수 음식점만 (사용자 정책: 카페·제과·주점 제외). "기타"는 카페류가 많아 통째로 제외.
const BAD_CAT = /(카페|커피|다방|제과|제빵|베이커리|아이스크림|디저트|찻집|호프|주점|술집|유흥|단란|노래|뷔페|출장|기타|패스트푸드)/;
// 전국 프랜차이즈는 "맛집 발굴" 컨셉에 안 맞는다 (실측: 버거킹 회현역점이 후보로 뽑힘)
const CHAIN_NAME =
  /(버거킹|맥도날드|롯데리아|KFC|맘스터치|서브웨이|쉑쉑|파파존스|도미노|피자헛|미스터피자|김밥천국|본죽|본도시락|한솥|빽다방|더벤티|메가커피|컴포즈|투썸|스타벅스|이디야|명륜진사|원할머니|놀부|채선당|아웃백|빕스|애슐리|한신포차|교촌|비비큐|BBQ|BHC|굽네|네네치킨|처갓집|호식이|60계|노브랜드|이삭토스트|역전우동|홍콩반점|새마을식당|한촌설렁탕|신전떡볶이|엽기떡볶이|청년다방)/i;
// 구축 당시 자동 생성된 소개 문구("~가 볼 만한 식당을 찾으신다면?")는 캡션 재료로 무가치
const TEMplated = /(찾으신다면|추천합니다!|가 ?볼 ?만한)/;

interface SeoulPlace {
  id: number;
  name: string;
  addr: string;
  lat: string | null;
  lng: string | null;
  cat: string;
  lic: string;
  intro: string;
  imgs: string[];
  /** 음식 사진(/food/img) 개수 — 나머지는 대부분 외관·골목 컷이라 이게 0이면 비전 통과율이 바닥(실측 1/4) */
  foodN?: number;
}

let cache: SeoulPlace[] | null = null;

function load(): SeoulPlace[] {
  if (cache) return cache;
  try {
    const j = JSON.parse(fs.readFileSync(FILE, "utf8"));
    // 음식 사진 보유 식당만. 외관 컷뿐인 곳은 비전에서 전멸해 Gemini 무료 한도만 태운다.
    cache = (j.places as SeoulPlace[]).filter(
      (p) =>
        p.name && p.addr && (p.foodN ?? 0) >= 1 && p.imgs?.length >= 2 &&
        !BAD_CAT.test(p.cat) && !BAD_CAT.test(p.lic) && !CHAIN_NAME.test(p.name)
    );
  } catch {
    cache = []; // 파일 없으면 소스 비활성 (TourAPI 단독으로 폴백)
  }
  return cache;
}

export function seoulAvailable(): boolean {
  return load().length > 0;
}

/** 무작위 후보 샘플 — Spot 모양으로 반환. imageUrls에 사진이 이미 실려 있다. */
export async function fetchSeoulCandidates(count = 12): Promise<Spot[]> {
  const all = load();
  if (!all.length) return [];
  const picked: SeoulPlace[] = [];
  const used = new Set<number>();
  while (picked.length < Math.min(count, all.length) && used.size < all.length) {
    const i = Math.floor(Math.random() * all.length);
    if (used.has(i)) continue;
    used.add(i);
    picked.push(all[i]);
  }
  return picked.map((p) => ({
    contentId: `seoul-${p.id}`,
    name: p.name,
    address: p.addr,
    category: "맛집",
    imageUrl: p.imgs[0],
    imageUrls: p.imgs,
    overview: TEMplated.test(p.intro) ? "" : p.intro,
    mapx: p.lng ?? undefined,
    mapy: p.lat ?? undefined,
  }));
}
