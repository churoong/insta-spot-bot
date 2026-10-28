/**
 * 캐릭터 "맛디" 에셋(2026-10-28 사용자 결정 — 프로필 사진과 같은 그림).
 *  - public/mascot.png        투명 배경 256px — 맛디 지도 핀·공개 페이지
 *  - assets/stickers/*.gif    GIPHY 스티커(투명 배경 480px) — 업로드는 사용자 GIPHY 계정으로
 * 실행: npx tsx scripts/make-mascot.mjs   (ffmpeg 필요, 시크릿 불필요)
 * 디그다 모티브지만 귀·주둥이·손·하트 코로 다른 캐릭터 — 포켓몬 캐릭터 자체는 쓰지 않는다.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";

const RED = "#e02020";

/** 1080 캔버스 기준 맛디. dy = 머리를 그릇 안으로 내린 정도, blink = 눈 감기, wave = 오른손 흔들기 각도 */
function mattiSvg({ bg = null, sparkle = false, dy = 0, blink = false, wave = 0, text = "" } = {}) {
  const eyes = [445, 635].map((x) => blink
    ? `<path d="M${x - 34},${588 + dy} q34,22 68,0" fill="none" stroke="#1d130e" stroke-width="14" stroke-linecap="round"/>`
    : `<ellipse cx="${x}" cy="${588 + dy}" rx="43" ry="52" fill="url(#eye)"/><circle cx="${x + 14}" cy="${567 + dy}" r="17" fill="#fff"/><circle cx="${x - 13}" cy="${608 + dy}" r="8" fill="#fff"/>`).join("");
  const sparkles = sparkle ? [[230, 300, 1.2], [855, 350, 0.85], [820, 215, 0.55], [190, 470, 0.5]].map(([x, y, s]) =>
    `<path transform="translate(${x},${y}) scale(${s})" d="M0,-30 C3,-9 9,-3 30,0 C9,3 3,9 0,30 C-3,9 -9,3 -30,0 C-9,-3 -3,-9 0,-30Z" fill="#f6b73c"/>`).join("") : "";
  const paw = (x, f, rot = 0) => `<g transform="translate(${x},764) scale(${f},1) rotate(${rot})"><ellipse cx="0" cy="0" rx="52" ry="35" fill="#f7b8b0" stroke="#d98c82" stroke-width="5"/>${[-26, 0, 26].map((d) => `<ellipse cx="${d}" cy="-31" rx="12" ry="17" fill="#f7b8b0" stroke="#d98c82" stroke-width="5"/>`).join("")}</g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080">
<defs>
  <radialGradient id="bg" cx="50%" cy="40%" r="70%"><stop offset="0" stop-color="#fff6ea"/><stop offset="1" stop-color="#ffe3c9"/></radialGradient>
  <radialGradient id="fur" cx="38%" cy="30%" r="80%"><stop offset="0" stop-color="#c99168"/><stop offset=".65" stop-color="#ad774f"/><stop offset="1" stop-color="#8f5d3a"/></radialGradient>
  <linearGradient id="bowl" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f23a3a"/><stop offset="1" stop-color="#c81616"/></linearGradient>
  <radialGradient id="eye" cx="40%" cy="35%" r="70%"><stop offset="0" stop-color="#4a3226"/><stop offset="1" stop-color="#1d130e"/></radialGradient>
  <clipPath id="above"><rect x="0" y="0" width="1080" height="790"/></clipPath>
</defs>
${bg ? `<rect width="1080" height="1080" fill="${bg}"/>` : ""}
${sparkles}
<g clip-path="url(#above)">
  <g transform="translate(560,${300 + dy}) rotate(14)">
    <rect x="-11" y="0" width="22" height="78" rx="11" fill="#7a4e30"/>
    <ellipse cx="0" cy="-36" rx="38" ry="50" fill="${RED}" stroke="#7a4e30" stroke-width="9"/>
    <ellipse cx="-12" cy="-52" rx="9" ry="15" fill="#fff" opacity=".6"/>
  </g>
  <circle cx="345" cy="${455 + dy}" r="54" fill="url(#fur)" stroke="#7a4e30" stroke-width="8"/><circle cx="345" cy="${455 + dy}" r="27" fill="#f2a99f"/>
  <circle cx="735" cy="${455 + dy}" r="54" fill="url(#fur)" stroke="#7a4e30" stroke-width="8"/><circle cx="735" cy="${455 + dy}" r="27" fill="#f2a99f"/>
  <ellipse cx="540" cy="${625 + dy}" rx="268" ry="258" fill="url(#fur)" stroke="#7a4e30" stroke-width="9"/>
  <path d="M335,${590 + dy} C340,${480 + dy} 405,${415 + dy} 480,${395 + dy}" fill="none" stroke="#fff" stroke-width="22" stroke-linecap="round" opacity=".3"/>
  <ellipse cx="540" cy="${688 + dy}" rx="108" ry="74" fill="#fdecdc"/>
  ${eyes}
  <ellipse cx="378" cy="${670 + dy}" rx="46" ry="29" fill="#ff7f7f" opacity=".75"/>
  <ellipse cx="702" cy="${670 + dy}" rx="46" ry="29" fill="#ff7f7f" opacity=".75"/>
  <path d="M540,${657 + dy} c-25,-23 -52,-2 -31,21 l31,29 l31,-29 c21,-23 -6,-44 -31,-21z" fill="${RED}"/>
  <path d="M512,${720 + dy} q14,18 28,0 q14,18 28,0" fill="none" stroke="#2a1d16" stroke-width="9" stroke-linecap="round"/>
</g>
<path d="M215,775 A325,290 0 0 0 865,775 Z" fill="url(#bowl)"/>
<rect x="195" y="752" width="690" height="48" rx="24" fill="#ff5050"/>
<rect x="215" y="757" width="650" height="12" rx="6" fill="#fff" opacity=".35"/>
<path d="M265,830 C285,930 360,990 430,1010" fill="none" stroke="#fff" stroke-width="16" stroke-linecap="round" opacity=".25"/>
<rect x="455" y="1036" width="170" height="30" rx="12" fill="#c81616"/>
<path d="M330,890 q105,40 210,0 q105,-40 210,0" fill="none" stroke="#fff7ec" stroke-width="16" stroke-linecap="round"/>
${dy < 120 ? paw(370, 1) + paw(710, -1, wave) : ""}
${text ? `<text x="540" y="1000" text-anchor="middle" font-family="'Gmarket Sans','Pretendard',sans-serif" font-weight="700" font-size="120" fill="#fff" stroke="#7a1010" stroke-width="10" paint-order="stroke">${text}</text>` : ""}
</svg>`;
}

const png = (svg, size) => sharp(Buffer.from(svg)).resize(size, size).png().toBuffer();

async function gif(name, frames, fps = 12) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "matti-"));
  for (let i = 0; i < frames.length; i++) fs.writeFileSync(path.join(dir, `f${String(i).padStart(3, "0")}.png`), await png(mattiSvg(frames[i]), 480));
  const out = `assets/stickers/${name}.gif`;
  const r = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", String(fps), "-i", path.join(dir, "f%03d.png"),
    "-filter_complex", "[0:v]split[a][b];[a]palettegen=reserve_transparent=1[p];[b][p]paletteuse=alpha_threshold=128",
    "-loop", "0", out], { stdio: "inherit" });
  fs.rmSync(dir, { recursive: true, force: true });
  if (r.status !== 0) throw new Error("ffmpeg 실패: " + name);
  console.log("스티커:", out, frames.length, "프레임");
}

fs.mkdirSync("assets/stickers", { recursive: true });
await sharp(await png(mattiSvg(), 256)).toFile("public/mascot.png");
console.log("핀 아이콘: public/mascot.png");

// ① 쏙 — 그릇에서 튀어나와 통통 튀고 눈 깜빡
const ease = (t) => 1 - Math.pow(1 - t, 3);
const pop = [];
for (let i = 0; i <= 6; i++) pop.push({ dy: Math.round(330 * (1 - ease(i / 6))) });
pop.push({ dy: -24 }, { dy: -10 }, { dy: 0 }, { dy: 0 }, { dy: 0 }, { dy: 0, blink: true }, { dy: 0 }, { dy: 0 }, { dy: 0 }, { dy: 0 });
for (let i = 0; i <= 5; i++) pop.push({ dy: Math.round(330 * ease(i / 5)) });
pop.push({ dy: 330 }, { dy: 330 });
await gif("matti-pop", pop);

// ② 안녕 — 손 흔들기
const hi = [];
for (let i = 0; i < 16; i++) hi.push({ wave: Math.round(Math.sin((i / 16) * Math.PI * 4) * 22), blink: i === 9 });
await gif("matti-hi", hi);

// ③ 맛디깅 글자 — 깜빡이며 통통
const tag = [];
for (let i = 0; i < 14; i++) tag.push({ dy: Math.round(Math.abs(Math.sin((i / 14) * Math.PI * 2)) * -18), blink: i === 7, text: "맛디깅" });
await gif("matti-tag", tag);
