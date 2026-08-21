import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * 릴스 배경음악 — Kevin MacLeod (incompetech.com), CC BY 4.0.
 *
 * 왜 이 소스인가: 완전 무료 정책상 상업 음원은 못 쓰고, API 발행 릴스에는
 * 인스타 음악 라이브러리도 붙일 수 없다(영상에 구워 넣어야 함). CC BY 4.0은
 * 캡션에 출처 한 줄만 넣으면 상업적 사용·재배포까지 합법이라 리포에 번들해도
 * 문제가 없다. (Pixabay류는 파일 단독 재배포 금지라 공개 리포 커밋이 회색지대)
 *
 * 파일은 assets/bgm/에 커밋되어 있고, 추가하려면 mp3를 넣고 TRACKS에 등록.
 */
const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "assets", "bgm");

const TRACKS: { file: string; title: string }[] = [
  { file: "monkeys-spinning-monkeys.mp3", title: "Monkeys Spinning Monkeys" },
  { file: "fluffing-a-duck.mp3", title: "Fluffing a Duck" },
  { file: "sneaky-snitch.mp3", title: "Sneaky Snitch" },
  { file: "carefree.mp3", title: "Carefree" },
  { file: "life-of-riley.mp3", title: "Life of Riley" },
];

export interface Bgm {
  path: string;
  title: string;
  /** CC BY 4.0 저작자 표시 — 캡션 맨 끝에 반드시 붙일 것 */
  attribution: string;
}

/** 랜덤 트랙 1개. 파일이 하나도 없으면 null(호출부는 기존 무음/음성 그대로 진행). */
export function pickBgm(): Bgm | null {
  const pool = TRACKS.filter((t) => {
    try {
      return fs.existsSync(path.join(DIR, t.file));
    } catch {
      return false;
    }
  });
  if (!pool.length) return null;
  const t = pool[Math.floor(Math.random() * pool.length)];
  return {
    path: path.join(DIR, t.file),
    title: t.title,
    attribution: `🎵 ${t.title} — Kevin MacLeod (incompetech.com), CC BY 4.0`,
  };
}
