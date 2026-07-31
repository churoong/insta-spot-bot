// 밸런스 게임(맛대맛) 게시물 — "짜장 vs 짬뽕"처럼 두 음식을 두고 댓글로 고르게 하는
// 참여 유도 포맷. 한글 텍스트를 이미지에 합성하므로 폰트가 설치된 GitHub Actions에서 실행.
//
// 필요 환경변수(Secrets): TOUR_API_KEY, GEMINI_API_KEY, GEMINI_MODEL, (선택)GROQ_KEY/GROQ_MODEL,
//   TURSO_DATABASE_URL, TURSO_AUTH_TOKEN, IG_USER_ID, IG_ACCESS_TOKEN, (선택)BLOB_READ_WRITE_TOKEN
//   BALANCE_DRY=1 이면 발행 없이 balance-preview.jpg 만 생성.

import fs from "node:fs";

const DRY = process.env.BALANCE_DRY === "1";
const FONT = "'Noto Sans CJK KR','NanumGothic','Malgun Gothic',sans-serif";

// 두 음식 모두 TourAPI 검색 결과가 충분한(≥14건) 조합만 — 사진 신뢰도 확보
const MATCHUPS = [
  ["족발", "보쌈"], ["칼국수", "막국수"], ["갈비", "불고기"], ["곰탕", "설렁탕"],
  ["회", "초밥"], ["떡볶이", "만두"], ["삼계탕", "추어탕"], ["감자탕", "돼지국밥"],
];

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * 해당 음식의 '실제 요리' 사진 1장. 여러 가게에서 음식 우선 사진을 모은 뒤,
 * 비전으로 그 음식이 먹음직스럽게 담긴 컷을 골라 건물·간판·메뉴판을 배제한다.
 */
async function bestFoodPhoto(keyword) {
  const { fetchByFoodKeyword, fetchQuizImages } = await import("../lib/tourapi.ts");
  const { geminiText } = await import("../lib/llm.ts");
  const cands = await fetchByFoodKeyword(keyword);
  const pool = [];
  for (const s of cands.slice(0, 6)) {
    try {
      const urls = await fetchQuizImages(s.contentId, s.imageUrl, "맛집");
      if (urls[0]) pool.push(urls[0]);
    } catch { /* 다음 후보 */ }
    if (pool.length >= 6) break;
  }
  if (!pool.length) return null;

  // 비전으로 '진짜 그 음식' 사진 고르기 (건물·간판·메뉴판·사람 위주 제외)
  const valid = [], parts = [];
  for (const u of pool) {
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(15000) });
      if (!r.ok) continue;
      const b = Buffer.from(await r.arrayBuffer());
      if (b.length > 900_000) continue;
      valid.push(u);
      parts.push({ inlineData: { mimeType: "image/jpeg", data: b.toString("base64") } });
    } catch { /* skip */ }
  }
  if (valid.length <= 1) return valid[0] ?? pool[0];
  try {
    const text = await geminiText(
      [
        { text: `사진 ${valid.length}장(1번부터). "${keyword}" 요리 자체가 먹음직스럽게 담긴 사진 1장의 번호만 숫자로 답해. 건물 외관·간판·메뉴판·사람 위주 사진은 제외. 적당한 게 없으면 0.` },
        ...parts,
      ],
      20
    );
    const n = parseInt(String(text ?? "").match(/\d+/)?.[0] ?? "0", 10);
    if (n >= 1 && n <= valid.length) return valid[n - 1];
  } catch { /* 비전 실패 시 첫 음식후보 */ }
  return valid[0];
}

/** 사진 다운 → 4:5 크롭 + 계정 톤 프리셋 (게시물과 색감 통일) */
async function tonePhoto(sharp, url, w, h) {
  const buf = Buffer.from(await (await fetch(url, { signal: AbortSignal.timeout(20000) })).arrayBuffer());
  return sharp(buf)
    .resize(w, h, { fit: "cover", position: sharp.strategy.attention })
    .modulate({ saturation: 1.1, brightness: 1.02 })
    .linear([1.05, 1.02, 0.97], [0, 0, 2])
    .sharpen({ sigma: 0.7 })
    .jpeg({ quality: 90 })
    .toBuffer();
}

/** 1080x1350 상/하 2분할 + 가운데 VS 뱃지 + 음식명 라벨 합성 */
async function compose(aName, bName, aUrl, bUrl) {
  const sharp = (await import("sharp")).default;
  const W = 1080, H = 1350, GAP = 20;
  const PH = Math.floor((H - GAP) / 2); // 위/아래 사진 높이
  const top = await tonePhoto(sharp, aUrl, W, PH);
  const bot = await tonePhoto(sharp, bUrl, W, H - PH - GAP);
  const cx = W / 2, cy = PH + GAP / 2;
  const overlay = Buffer.from(
    `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="${PH}" width="${W}" height="${GAP}" fill="#ffffff"/>
      <rect x="${cx - 175}" y="40" width="350" height="72" rx="36" fill="#000" fill-opacity="0.55"/>
      <text x="${cx}" y="90" font-family="${FONT}" font-size="42" font-weight="800" fill="#fff" text-anchor="middle">${esc(aName)}</text>
      <rect x="${cx - 175}" y="${H - 112}" width="350" height="72" rx="36" fill="#000" fill-opacity="0.55"/>
      <text x="${cx}" y="${H - 62}" font-family="${FONT}" font-size="42" font-weight="800" fill="#fff" text-anchor="middle">${esc(bName)}</text>
      <circle cx="${cx}" cy="${cy}" r="76" fill="#d92121" stroke="#fff" stroke-width="8"/>
      <text x="${cx}" y="${cy + 21}" font-family="Arial, sans-serif" font-size="60" font-weight="900" fill="#fff" text-anchor="middle">VS</text>
    </svg>`
  );
  return sharp({ create: { width: W, height: H, channels: 3, background: "#ffffff" } })
    .composite([
      { input: top, top: 0, left: 0 },
      { input: bot, top: PH + GAP, left: 0 },
      { input: overlay, top: 0, left: 0 },
    ])
    .jpeg({ quality: 90 })
    .toBuffer();
}

function caption(a, b) {
  return (
    `🥢 오늘의 맛대맛! ${a} vs ${b}\n\n` +
    `여러분의 선택은? 댓글로 알려주세요 👇\n둘 다 좋다면… 그것도 정답이에요 😋\n\n` +
    `#맛대맛 #밸런스게임 #${a} #${b} #뭐먹지 #맛집추천 #먹스타그램 #맛스타그램 #국내맛집 #맛집투어\n\n` +
    `📷 사진 출처: 한국관광공사 TourAPI`
  );
}

async function main() {
  const { db, initDb } = await import("../lib/db.ts");
  const { publishImage } = await import("../lib/instagram.ts");
  const { uploadPublicImage } = await import("../lib/upload.ts");
  await initDb();

  // 발행 쿨다운(행동차단 회복) 중이면 쉼
  if (!DRY) {
    const cd = await db.execute("SELECT value FROM config WHERE key='publish_cooldown_until'");
    if (cd.rows.length > 0) {
      const until = new Date(String(cd.rows[0].value).replace(" ", "T") + "Z").getTime();
      if (Date.now() < until) {
        console.log("발행 쿨다운 중 — 밸런스 건너뜀 (" + Math.round((until - Date.now()) / 60000) + "분 남음)");
        return;
      }
    }
  }

  // 매치업은 월 1회까지 반복 허용(월 버킷 dedup) → 콘텐츠 고갈 없이 순환
  const month = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 7);
  for (const [a, b] of [...MATCHUPS].sort(() => Math.random() - 0.5)) {
    const cid = `balance-${a}-${b}-${month}`;
    const dup = await db.execute({ sql: "SELECT 1 FROM posts WHERE content_id = ?", args: [cid] });
    if (dup.rows.length) continue;

    const [aUrl, bUrl] = await Promise.all([bestFoodPhoto(a), bestFoodPhoto(b)]);
    if (!aUrl || !bUrl) {
      console.log(`사진 부족으로 건너뜀: ${a} / ${b}`);
      continue;
    }
    const img = await compose(a, b, aUrl, bUrl);

    if (DRY) {
      fs.writeFileSync("balance-preview.jpg", img);
      console.log(`DRY — ${a} vs ${b} → balance-preview.jpg`);
      console.log(caption(a, b));
      return;
    }

    const url = await uploadPublicImage(img, "balance");
    const cap = caption(a, b);
    const mediaId = await publishImage(url, cap);
    console.log(`✅ 밸런스 발행: ${a} vs ${b} (media ${mediaId})`);
    await db.execute({
      sql: `INSERT INTO posts (content_id, place_name, address, category, image_url, caption, ig_media_id, status)
            VALUES (?, ?, ?, '밸런스', ?, ?, ?, 'published')`,
      args: [cid, `${a} vs ${b}`, "", url, cap, mediaId],
    });
    return;
  }
  console.log("발행할 새 매치업 없음 (이번 달 전부 사용 또는 사진 부족)");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("밸런스 실패:", e);
    process.exit(1);
  });
