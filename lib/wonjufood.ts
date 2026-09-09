import fs from "node:fs";
import path from "node:path";

/**
 * 강원도 원주시 식당 DB — 강원 지역의 사진 소스.
 *
 * 강원은 TourAPI 사진 보유율이 58.6%로 전국 최약체고 원주는 26곳뿐이라 상권 편을 못 만들었다.
 * 이 데이터(공공데이터 15076726/15077719)는 사진 951장·좌표 100%·소개문 100%를 주고,
 * 카페·폐업·체인을 걸러도 300곳이 남는다.
 *
 * scripts/build-wonju-db.mjs 가 odcloud에서 받아 data/wonju-food.json 으로 굳혀 두고,
 * 런타임은 그 파일만 읽는다(발행마다 8페이지를 받으면 20초씩 까먹는다).
 * ⚠️ 원본 이미지 호스트는 DNS가 소멸했다 — 빌드 시점에 살아있는 버킷으로 치환해 저장한다.
 */

const FILE = path.join(process.cwd(), "data", "wonju-food.json");

export interface WonjuPlace {
  id: number | string;
  name: string;
  addr: string;
  lat: number;
  lng: number;
  cat: string;
  intro: string;
  imgs: string[];
}

let cache: WonjuPlace[] | null = null;

function load(): WonjuPlace[] {
  if (cache) return cache;
  try {
    cache = (JSON.parse(fs.readFileSync(FILE, "utf8")).places as WonjuPlace[]).filter(
      (p) => p.name && p.lat && p.lng && p.imgs?.length
    );
  } catch {
    cache = []; // 파일 없으면 소스 비활성 (TourAPI 단독으로 폴백)
  }
  return cache;
}

export function wonjuAvailable(): boolean {
  return load().length > 0;
}

/** 좌표 반경 안의 원주 식당 (상권 모음집 풀 보강용) */
export function wonjuNearby(lat: number, lng: number, radiusM: number): WonjuPlace[] {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  return load().filter((p) => {
    const dLat = toRad(p.lat - lat), dLng = toRad(p.lng - lng);
    const a =
      Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat)) * Math.cos(toRad(p.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a)) <= radiusM;
  });
}
