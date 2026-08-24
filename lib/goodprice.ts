import fs from "node:fs";
import path from "node:path";

/**
 * 행정안전부 착한가격업소(12,645곳) 대조 — 백년가게(hundred)와 같은 배지 용법.
 * data/goodprice.json은 scripts/build-goodprice.mjs가 생성(분기 1회 재실행).
 * 메뉴·가격이 있어 "국밥 7,500원" 같은 가성비 서사를 설명·캡션에 쓸 수 있다.
 */

const FILE = path.join(process.cwd(), "data", "goodprice.json");

interface GoodShop {
  sd: string; // 시도
  sg: string; // 시군구
  n: string; // 업소명
  m: string; // 대표 메뉴
  p: string; // 가격(숫자 문자열)
}

let cache: GoodShop[] | null = null;
function load(): GoodShop[] {
  if (cache) return cache;
  try {
    cache = (JSON.parse(fs.readFileSync(FILE, "utf8")).shops as GoodShop[]) ?? [];
  } catch {
    cache = [];
  }
  return cache;
}

const normName = (s: string) => String(s).replace(/\([^)]*\)/g, "").replace(/[\s·.-]/g, "");
const normRegion = (s: string) => String(s).replace(/(특별자치도|특별자치시|특별시|광역시|도|시|군|구)$/g, "");

export interface GoodPriceHit {
  menu: string;
  price: number; // 원 단위 (없으면 0)
}

/**
 * places 각각에 goodPrice({menu, price})를 마킹.
 * 매칭: 업소명 정규화 포함관계 + 시도 일치(주소 첫 토큰) + 시군 일치(둘째 토큰, 있으면).
 * 동명이인 가게 오인을 줄이려고 지역이 어긋나면 매칭하지 않는다.
 */
export function markGoodPrice<T extends { name: string; address?: string; goodPrice?: GoodPriceHit }>(
  places: T[]
): number {
  const shops = load();
  if (!shops.length) return 0;
  let hit = 0;
  for (const p of places) {
    const pn = normName(p.name);
    if (pn.length < 2) continue;
    const parts = String(p.address ?? "").split(/\s+/);
    const sido = normRegion(parts[0] ?? "");
    const sigungu = normRegion(parts[1] ?? "");
    const found = shops.find((s) => {
      const sn = normName(s.n);
      if (!sn || !(sn.includes(pn) || pn.includes(sn))) return false;
      if (sido && normRegion(s.sd) && !normRegion(s.sd).startsWith(sido.slice(0, 2))) return false;
      if (sigungu && normRegion(s.sg) && normRegion(s.sg) !== sigungu) return false;
      return true;
    });
    if (found) {
      p.goodPrice = { menu: found.m, price: Number(found.p) || 0 };
      hit++;
    }
  }
  return hit;
}
