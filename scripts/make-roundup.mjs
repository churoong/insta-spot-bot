// 모음집(공개형 N선) 자동 생성·발행 — GitHub Actions에서 실행.
// 흐름: 계절 가중 테마 선택 → TourAPI 수집(공공누리 확인) → 백년가게 대조 →
//       Gemini 한줄평·음식사진 선별 → v2 인포그래픽 표지 + 이름표 슬라이드 합성 →
//       업로드 → 캐러셀 발행 → Turso 기록.
//
// 필요한 환경변수: TOUR_API_KEY, GEMINI_API_KEY, GEMINI_MODEL,
//   TURSO_DATABASE_URL, TURSO_AUTH_TOKEN, IG_USER_ID, IG_ACCESS_TOKEN
//   (선택) BLOB_READ_WRITE_TOKEN, IG_USERNAME, ROUNDUP_DRY=1(발행 없이 미리보기 파일 생성)

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "roundup-"));
const TOUR = "https://apis.data.go.kr/B551011/KorService2";
const DRY = process.env.ROUNDUP_DRY === "1";
const HANDLE = process.env.IG_USERNAME || "tourist_710";
const FONT = "'Noto Sans CJK KR','NanumGothic','Malgun Gothic',sans-serif";

const SIDO_SHORT = {
  서울특별시: "서울", 부산광역시: "부산", 대구광역시: "대구", 인천광역시: "인천",
  광주광역시: "광주", 대전광역시: "대전", 울산광역시: "울산", 세종특별자치시: "세종",
  경기도: "경기", 강원도: "강원", 강원특별자치도: "강원",
  충청북도: "충북", 충청남도: "충남", 전라북도: "전북", 전북특별자치도: "전북",
  전라남도: "전남", 경상북도: "경북", 경상남도: "경남",
  제주특별자치도: "제주", 제주도: "제주",
};

const BAD_IMG_NAME =
  /(화장실|주차|기저귀|수유|경사로|안내도|안내판|표지판|매표|엘리베이터|승강기|휠체어|점자|유도블록|소화전|진입로|비상|피난|보관함|안내소|계산대)/;

const toHttps = (u) => String(u ?? "").replace(/^http:/, "https:");
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const normName = (s) => String(s).replace(/\[[^\]]*\]/g, "").replace(/\s+/g, "");

function shortRegion(addr) {
  const parts = String(addr ?? "").split(/\s+/);
  const sido = SIDO_SHORT[parts[0]] ?? (parts[0] ?? "").slice(0, 2);
  const gu = (parts[1] ?? "").replace(/(특별자치)?(시|군|구)$/, "");
  return [sido, gu].filter(Boolean).join(" ");
}

/**
 * TourAPI 호출.
 * ⚠️ data.go.kr이 GitHub Actions 러너 IP를 간헐적으로 차단(ConnectTimeout)해
 *    발행이 통째로 실패한 적이 있다. 그래서 Vercel 프록시(/api/tour-proxy)를
 *    1순위로 쓰고, 실패하면 직접 호출로 폴백한다. 각 경로마다 2회씩 재시도.
 */
async function tourCall(endpoint, params) {
  const base = (process.env.APP_BASE_URL || "https://insta-spot-bot.vercel.app").replace(/\/$/, "");
  const secret = process.env.CRON_SECRET;

  // 1순위: Vercel 프록시 (Actions IP 차단 우회)
  if (secret) {
    for (let i = 0; i < 2; i++) {
      try {
        const pq = new URLSearchParams({ endpoint, ...params });
        const r = await fetch(`${base}/api/tour-proxy?${pq}`, {
          headers: { Authorization: `Bearer ${secret}` },
          signal: AbortSignal.timeout(40000),
        });
        if (r.ok) {
          const j = await r.json();
          if (Array.isArray(j.items)) return j.items;
        }
      } catch (e) {
        console.error(`[tour] 프록시 실패(${i + 1}):`, String(e).slice(0, 80));
      }
    }
  }

  // 폴백: 직접 호출
  let lastErr = null;
  for (let i = 0; i < 2; i++) {
    try {
      const qs = new URLSearchParams({
        serviceKey: process.env.TOUR_API_KEY,
        MobileOS: "ETC", MobileApp: "instaSpotBot", _type: "json", ...params,
      });
      const res = await fetch(`${TOUR}/${endpoint}?${qs}`, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`TourAPI ${endpoint} HTTP ${res.status}`);
      const json = await res.json();
      const items = json?.response?.body?.items?.item;
      return Array.isArray(items) ? items : items ? [items] : [];
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error(`TourAPI ${endpoint} 실패`);
}

/** 테마에 맞는 식당 수집 (사진 + 공공누리 Type1/3, 시군구당 최대 2곳) */
async function collectPlaces(theme) {
  const params = { keyword: theme.keyword, contentTypeId: "39", numOfRows: "100", arrange: "R" };
  if (theme.areaCode) params.areaCode = String(theme.areaCode);
  let items = await tourCall("searchKeyword2", params);
  items = items.filter(
    (it) => it.firstimage && (it.cpyrhtDivCd === "Type1" || it.cpyrhtDivCd === "Type3")
  );
  const seen = {};
  const picked = [];
  for (const it of items.sort(() => Math.random() - 0.5)) {
    const rg = shortRegion(it.addr1);
    if ((seen[rg] ?? 0) >= 2) continue;
    seen[rg] = (seen[rg] ?? 0) + 1;
    picked.push({
      contentId: String(it.contentid),
      name: String(it.title).replace(/\[[^\]]*\]/g, "").trim(),
      address: [it.addr1, it.addr2].filter(Boolean).join(" "),
      region: rg,
      imageUrl: toHttps(it.firstimage),
    });
    if (picked.length >= theme.count) break;
  }
  return picked;
}

/** 백년가게 목록(DB 캐시)과 대조 → 해당 가게에 hundred 플래그 */
async function markHundredYear(db, places) {
  try {
    const r = await db.execute("SELECT value FROM config WHERE key = 'hys_list'");
    if (!r.rows.length) return;
    const names = JSON.parse(String(r.rows[0].value)).map((e) => normName(e.name));
    for (const p of places) {
      const pn = normName(p.name);
      if (names.some((n) => n && (pn.includes(n) || n.includes(pn)))) p.hundred = true;
    }
  } catch {
    /* 무시 */
  }
}

/** 가게별 이미지 중 Gemini 비전으로 음식 사진 선택 (실패 시 기존 유지) */
async function pickFoodImage(place) {
  try {
    const items = await tourCall("detailImage2", {
      contentId: place.contentId, imageYN: "Y", numOfRows: "15",
    });
    const cands = [
      { url: place.imageUrl, small: place.imageUrl },
      ...items
        .filter((it) => !(it.imgname && BAD_IMG_NAME.test(it.imgname)))
        .map((it) => ({
          url: toHttps(it.originimgurl || it.smallimageurl),
          small: toHttps(it.smallimageurl || it.originimgurl),
        })),
    ]
      .filter((v, i, a) => v.url && a.findIndex((x) => x.url === v.url) === i)
      .slice(0, 6);
    if (cands.length <= 1 || !process.env.GEMINI_API_KEY) return;

    const valid = [], parts = [];
    for (const c of cands) {
      try {
        const res = await fetch(c.small, { signal: AbortSignal.timeout(15000) });
        if (!res.ok) continue;
        const b = Buffer.from(await res.arrayBuffer());
        if (b.length > 900_000) continue;
        valid.push(c);
        parts.push({ inlineData: { mimeType: "image/jpeg", data: b.toString("base64") } });
      } catch { /* skip */ }
    }
    if (valid.length <= 1) return;

    const text =
      (await geminiCall(
        [
          { text: `식당 사진 ${valid.length}장이야. 음식(요리·메뉴)이 크고 먹음직스럽게 보이는 사진의 번호를 좋은 순서대로 JSON 배열로만 답해 (1번부터). 건물 외관·간판·내부 전경은 제외. 음식 사진이 없으면 []. 예: [3,1]` },
          ...parts,
        ],
        60
      )) ?? "";
    const m = text.match(/\[[\d,\s]*\]/);
    const order = m ? JSON.parse(m[0]) : [];
    const best = order.length ? valid[Number(order[0]) - 1] : null;
    if (best?.url) {
      place.imageUrl = best.url;
      place.foodPicked = true;
    }
  } catch { /* 기존 이미지 유지 */ }
}

/**
 * Gemini 호출 (텍스트/비전 공용). thinking 없는 경량 모델(gemini-flash-lite-latest) 기본.
 * gemini-flash-latest는 thinking 전용이라 긴 출력이 잘리고 thinkingBudget:0에 400을
 * 반환하므로(2026-07 실측), env에 그 값이 있어도 무시하고 경량 모델로 자동 교정.
 * thinkingConfig는 최신 모델들이 400을 내므로 아예 보내지 않음.
 */
function geminiModel() {
  const m = process.env.GEMINI_MODEL;
  return m && m !== "gemini-flash-latest" ? m : "gemini-flash-lite-latest";
}
async function geminiCall(parts, maxTokens) {
  if (!process.env.GEMINI_API_KEY) return null;
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel()}:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts }], generationConfig: { maxOutputTokens: maxTokens } }),
        signal: AbortSignal.timeout(40000),
      }
    );
    const j = await res.json();
    if (j?.error) {
      console.log("[llm] Gemini 실패:", j.error.code ?? "", String(j.error.message ?? "").slice(0, 80));
      return null;
    }
    const cand = j?.candidates?.[0];
    const t = (cand?.content?.parts?.filter((p) => !p.thought).map((p) => p.text ?? "").join("") ?? "").trim();
    if (t && cand?.finishReason === "STOP") return t;
    if (t && cand?.finishReason) console.log("[llm] Gemini 응답 잘림:", cand.finishReason);
    return null;
  } catch (e) {
    console.log("[llm] Gemini 오류:", String(e).slice(0, 80));
    return null;
  }
}

/** 텍스트 생성 폴백 체인: Gemini → Groq(무료). 모두 실패하면 null. */
async function llmGenerate(prompt, maxTokens) {
  const g = await geminiCall([{ text: prompt }], maxTokens);
  if (g) return g;
  if (process.env.GROQ_KEY) {
    try {
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.GROQ_KEY}` },
        body: JSON.stringify({
          model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
          messages: [{ role: "user", content: prompt }],
          max_tokens: maxTokens,
          temperature: 0.8,
        }),
        signal: AbortSignal.timeout(40000),
      });
      const j = await res.json();
      const t = (j?.choices?.[0]?.message?.content ?? "").trim();
      if (t) return t;
      if (j?.error) console.log("[llm] Groq 실패:", String(j.error.message ?? "").slice(0, 80));
    } catch (e) {
      console.log("[llm] Groq 오류:", String(e).slice(0, 80));
    }
  }
  return null;
}

/** 한줄평(표지용) + 상세 설명(슬라이드용) 생성 — 모든 AI 실패 시 null(모음집 발행 스킵) */
async function makeDescriptions(theme, places) {
  const prompt = `인스타 카드뉴스용 문구를 만들어줘. 주제: "${theme.keyword} 맛집 모음"
식당 목록:
${places.map((p, i) => `${i + 1}. ${p.name} (${p.region})`).join("\n")}

각 식당마다 두 가지를 만들어:
- s: 표지용 짧은 한줄평 (10~16자, 명사형 종결. 예: "깊고 깔끔한 사골국물")
- d: 상세 슬라이드용 설명 (28~40자, 존댓말 해요체 1~2문장. 메뉴 특징·분위기를 구체적으로. 예: "진한 사골 육수에 수제 순대가 푸짐해요. 웨이팅이 있어도 기다릴 가치가 있는 곳!")

규칙: 상호명 반복 금지, 과장·허위 금지(일반적 묘사만), 지역 특색 살리면 좋음.
JSON 배열만 출력: [{"s":"...","d":"..."}, ...] (${places.length}개)`;
  const text = await llmGenerate(prompt, 1600);
  if (!text) return null;
  try {
    const m = text.match(/\[[\s\S]*\]/);
    if (!m) return null;
    const arr = JSON.parse(m[0]);
    if (!Array.isArray(arr) || !arr.some((x) => x?.s && x?.d)) return null;
    const fbShort = "현지에서 오래 사랑받아온 곳";
    const fbDetail = `${theme.keyword} 하나로 오랜 시간 사랑받아온, 믿고 찾아갈 수 있는 곳이에요.`;
    return places.map((_, i) => ({
      short: String(arr[i]?.s ?? fbShort).slice(0, 22),
      detail: String(arr[i]?.d ?? fbDetail).slice(0, 48),
    }));
  } catch {
    return null;
  }
}

/**
 * 릴스용 표지(1080x1920): 원본 인포그래픽 그리드 스타일 유지(사진+번호+이름+지역칩+한줄소개),
 * 배경만 음식 사진(어둡고 따뜻한 오버레이)으로 먹음직스럽게. 릴스 규격에 딱 맞음.
 */
async function composeReelCover(theme, places) {
  const sharp = (await import("sharp")).default;
  const W = 1080, H = 1920, HEADER = 210, FOOTER = 110;
  const rows = Math.ceil(places.length / 2);
  const CELL_W = 540, CELL_H = Math.floor((H - HEADER - FOOTER) / rows);
  const PHOTO_W = 250, PAD = 12;
  const emoji = theme.emoji || "💡";

  // 배경: 음식 판별 사진 풀블리드 + 따뜻한 어두운 오버레이 (블러 없음)
  const bgPlace = places.find((p) => p.foodPicked) ?? places[0];
  const bgRes = await fetch(bgPlace.imageUrl, { signal: AbortSignal.timeout(20000) });
  if (!bgRes.ok) throw new Error("릴스 배경 사진 실패");
  const bgPhoto = await sharp(Buffer.from(await bgRes.arrayBuffer()))
    .resize(W, H, { fit: "cover" })
    .modulate({ saturation: 1.12 })
    .jpeg({ quality: 86 })
    .toBuffer();

  const cellPos = (i) => {
    const lastOdd = places.length % 2 === 1 && i === places.length - 1;
    const col = i % 2, row = Math.floor(i / 2);
    return { x: lastOdd ? (W - CELL_W) / 2 : col * CELL_W, y: HEADER + row * CELL_H };
  };

  const photoLayers = [];
  for (let i = 0; i < places.length; i++) {
    try {
      const res = await fetch(places[i].imageUrl, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      const { x, y } = cellPos(i);
      const resized = await sharp(buf)
        .resize(PHOTO_W, CELL_H - PAD * 2, { fit: "cover" })
        .jpeg({ quality: 82 })
        .toBuffer();
      photoLayers.push({ input: resized, left: x + CELL_W - PHOTO_W - PAD, top: y + PAD });
    } catch { /* 사진 실패 시 텍스트만 */ }
  }

  let bgCells = "", textCells = "";
  for (let i = 0; i < places.length; i++) {
    const p = places[i];
    const { x, y } = cellPos(i);
    const nm = p.name.length > 11 ? p.name.slice(0, 10) + "…" : p.name;
    const ns = nm.length <= 7 ? 31 : nm.length <= 9 ? 25 : 20;
    const d1 = (p.desc ?? "").slice(0, 12), d2 = (p.desc ?? "").slice(12, 24);
    const chipW = p.region.length * 21 + 48;
    bgCells += `<rect x="${x + 8}" y="${y + 6}" width="${CELL_W - 16}" height="${CELL_H - 12}" rx="16" fill="white" fill-opacity="0.96" stroke="#f1dede" stroke-width="2"/>`;
    textCells += `
    <g>
      <rect x="${x + PAD + 8}" y="${y + PAD + 12}" width="46" height="46" rx="12" fill="#d92121"/>
      <text x="${x + PAD + 31}" y="${y + PAD + 45}" font-family="${FONT}" font-size="29" font-weight="800" fill="#fff" text-anchor="middle">${i + 1}</text>
      <text x="${x + PAD + 64}" y="${y + PAD + 44}" font-family="${FONT}" font-size="${ns}" font-weight="800" fill="#b81414">${esc(nm)}</text>
      <rect x="${x + PAD + 8}" y="${y + PAD + 66}" width="${chipW}" height="36" rx="18" fill="#f6ede7"/>
      <text x="${x + PAD + 8 + chipW / 2}" y="${y + PAD + 91}" font-family="${FONT}" font-size="21" font-weight="700" fill="#8a5a44" text-anchor="middle">📍 ${esc(p.region)}</text>
      ${p.hundred ? `<rect x="${x + PAD + 8 + chipW + 8}" y="${y + PAD + 66}" width="112" height="36" rx="18" fill="#fff3d6" stroke="#e8c66a" stroke-width="1.5"/>
      <text x="${x + PAD + 8 + chipW + 64}" y="${y + PAD + 91}" font-family="${FONT}" font-size="20" font-weight="800" fill="#9a7419" text-anchor="middle">백년가게</text>` : ""}
      <text x="${x + PAD + 10}" y="${y + PAD + 140}" font-family="${FONT}" font-size="23" fill="#333">${emoji} ${esc(d1)}</text>
      ${d2 ? `<text x="${x + PAD + 10}" y="${y + PAD + 172}" font-family="${FONT}" font-size="23" fill="#333">${esc(d2)}</text>` : ""}
    </g>`;
  }

  const titleText = String(theme.titleResolved || "");
  const ts = titleText.length <= 11 ? 72 : titleText.length <= 14 ? 62 : 52;
  const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <rect x="0" y="0" width="${W}" height="${H}" fill="#1a0d08" fill-opacity="0.55"/>
    <text x="${W / 2}" y="100" font-family="${FONT}" font-size="${ts}" font-weight="900" fill="#ffffff" text-anchor="middle">${esc(titleText)}</text>
    <text x="${W / 2}" y="165" font-family="${FONT}" font-size="30" font-weight="700" fill="#ffd9c9" text-anchor="middle">✦ 저장해두고 하나씩 정복해 보세요 ✦</text>
    ${bgCells}
    <text x="${W / 2}" y="${H - 62}" font-family="${FONT}" font-size="30" font-weight="800" fill="#ffffff" text-anchor="middle">자세한 소개는 피드 게시물에서 📌</text>
    <text x="${W / 2}" y="${H - 22}" font-family="${FONT}" font-size="24" fill="#e0cfc4" text-anchor="middle">@${HANDLE}</text>
  </svg>`;
  const textSvg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${textCells}</svg>`;

  const out = path.join(TMP, "reel-cover.jpg");
  await sharp(bgPhoto)
    .composite([
      { input: Buffer.from(svg), left: 0, top: 0 },
      ...photoLayers,
      { input: Buffer.from(textSvg), left: 0, top: 0 },
    ])
    .jpeg({ quality: 88 })
    .toFile(out);
  return out;
}

/** 자극형 제목 템플릿 랜덤 선택 — "가장 맛있는 집" 이미지의 강한 제목 */
function buildPunchyTitle(theme, n) {
  const r = theme.region || "전국";
  const f = theme.food || theme.keyword;
  const sfx = theme.suffix || "맛집";
  const pool = [
    `${r} ${f} ${n}대 ${sfx}`,
    `${r} ${f} 레전드 ${n}선`,
    `맛도리 ${f} ${n}선`,
    `${r} ${f} ${sfx} TOP ${n}`,
    `놓치면 후회하는 ${f} ${n}선`,
    `${r}에서 제일 맛있는 ${f} ${n}곳`,
  ];
  return pool[Math.floor(Math.random() * pool.length)];
}

// ===== 카운트다운 릴스용 카드 (한 곳씩 크게 공개 → 1위 보려고 끝까지 봄) =====

const RW = 1080, RH = 1920;

/** 텍스트를 지정 글자수로 줄바꿈 */
function wrapLines(text, per, maxLines) {
  const words = String(text ?? "").split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > per && cur) { lines.push(cur.trim()); cur = w; }
    else cur = (cur + " " + w).trim();
  }
  if (cur) lines.push(cur);
  return lines.slice(0, maxLines);
}

/** 배경 사진을 세로 규격으로 (왜곡 없이) + 어둡게 */
async function bgFrame(sharp, imgUrl, brightness = 0.5, blur = 0) {
  const res = await fetch(imgUrl, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`배경 사진 실패 ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  let p = sharp(buf).resize(RW, RH, { fit: "cover", position: sharp.strategy.attention })
    .modulate({ brightness, saturation: 1.06 });
  if (blur > 0) p = p.blur(blur);
  return p.toBuffer();
}

/** 인트로 카드 — "부산 돼지국밥 TOP 8" 같은 제목을 크게 */
async function composeIntroCard(sharp, theme, places, title, rankBasis = "") {
  const bg = await bgFrame(sharp, (places.find((p) => p.foodPicked) ?? places[0]).imageUrl, 0.4, 8);
  const lines = wrapLines(title, 10, 3);
  const size = lines.length >= 3 ? 100 : lines.length === 2 ? 116 : 128;
  const lineH = Math.round(size * 1.28);
  const startY = Math.round(RH / 2 - ((lines.length - 1) * lineH) / 2);
  const svg = Buffer.from(
    `<svg width="${RW}" height="${RH}" xmlns="http://www.w3.org/2000/svg">
      ${lines
        .map(
          (l, i) =>
            `<text x="${RW / 2}" y="${startY + i * lineH}" font-family="${FONT}" font-size="${size}" font-weight="900" fill="#fff" text-anchor="middle" stroke="#000" stroke-width="9" paint-order="stroke">${esc(l)}</text>`
        )
        .join("")}
      <text x="${RW / 2}" y="${startY + lines.length * lineH + 40}" font-family="${FONT}" font-size="48" font-weight="700" fill="#ffd9a0" text-anchor="middle" stroke="#000" stroke-width="6" paint-order="stroke">끝까지 보고 저장하세요</text>
    </svg>`
  );
  return sharp(bg).composite([{ input: svg, top: 0, left: 0 }]).jpeg({ quality: 92 }).toBuffer();
}

/** 순위 카드 — 큰 순위 숫자 + 상호명 + 지역 + 한줄평 */
async function composeRankCard(sharp, place, rank) {
  const bg = await bgFrame(sharp, place.imageUrl, 0.62, 0);
  const nameLines = wrapLines(place.name, 11, 2);
  const nameSize = nameLines.length === 2 ? 78 : 92;
  const descLines = wrapLines(place.desc || "", 16, 2);
  const boxTop = RH - 760;
  const svg = Buffer.from(
    `<svg width="${RW}" height="${RH}" xmlns="http://www.w3.org/2000/svg">
      <!-- 순위 뱃지 -->
      <circle cx="${RW / 2}" cy="330" r="118" fill="#d92121" stroke="#fff" stroke-width="10"/>
      <text x="${RW / 2}" y="${330 + 46}" font-family="${FONT}" font-size="120" font-weight="900" fill="#fff" text-anchor="middle">${rank}</text>
      <!-- 하단 정보 박스 -->
      <rect x="0" y="${boxTop}" width="${RW}" height="${RH - boxTop - 300}" fill="#000" fill-opacity="0.5"/>
      ${nameLines
        .map(
          (l, i) =>
            `<text x="${RW / 2}" y="${boxTop + 110 + i * Math.round(nameSize * 1.2)}" font-family="${FONT}" font-size="${nameSize}" font-weight="900" fill="#fff" text-anchor="middle" stroke="#000" stroke-width="7" paint-order="stroke">${esc(l)}</text>`
        )
        .join("")}
      <text x="${RW / 2}" y="${boxTop + 110 + nameLines.length * Math.round(nameSize * 1.2) + 20}" font-family="${FONT}" font-size="52" font-weight="700" fill="#ffd9a0" text-anchor="middle" stroke="#000" stroke-width="5" paint-order="stroke">${esc(place.region || "")}${place.hundred ? " · 백년가게" : ""}</text>
      ${descLines
        .map(
          (l, i) =>
            `<text x="${RW / 2}" y="${boxTop + 110 + nameLines.length * Math.round(nameSize * 1.2) + 100 + i * 58}" font-family="${FONT}" font-size="46" font-weight="600" fill="#f0f0f0" text-anchor="middle" stroke="#000" stroke-width="4" paint-order="stroke">${esc(l)}</text>`
        )
        .join("")}
    </svg>`
  );
  return sharp(bg).composite([{ input: svg, top: 0, left: 0 }]).jpeg({ quality: 92 }).toBuffer();
}

/** 아웃트로 카드 — 저장·팔로우 유도 */
async function composeOutroCard(sharp, places, title) {
  const bg = await bgFrame(sharp, places[0].imageUrl, 0.35, 12);
  const svg = Buffer.from(
    `<svg width="${RW}" height="${RH}" xmlns="http://www.w3.org/2000/svg">
      <text x="${RW / 2}" y="${RH / 2 - 60}" font-family="${FONT}" font-size="104" font-weight="900" fill="#fff" text-anchor="middle" stroke="#000" stroke-width="9" paint-order="stroke">저장 필수</text>
      <text x="${RW / 2}" y="${RH / 2 + 70}" font-family="${FONT}" font-size="58" font-weight="700" fill="#ffd9a0" text-anchor="middle" stroke="#000" stroke-width="6" paint-order="stroke">${esc(wrapLines(title, 16, 1)[0] || "")}</text>
      <text x="${RW / 2}" y="${RH / 2 + 180}" font-family="${FONT}" font-size="50" font-weight="700" fill="#fff" text-anchor="middle" stroke="#000" stroke-width="5" paint-order="stroke">@${esc(HANDLE)}</text>
    </svg>`
  );
  return sharp(bg).composite([{ input: svg, top: 0, left: 0 }]).jpeg({ quality: 92 }).toBuffer();
}

/** v2 표지 인포그래픽: 레드 배너 + 지역 칩 + 백년가게 배지 + 다크 푸터 */
async function composeCover(theme, places) {
  const sharp = (await import("sharp")).default;
  const W = 1080, HEADER = 180, FOOTER = 84;
  const rows = Math.ceil(places.length / 2);
  const CELL_W = 540, CELL_H = Math.floor((1350 - HEADER - FOOTER) / rows);
  const H = HEADER + CELL_H * rows + FOOTER;
  const PHOTO_W = 250, PAD = 12;
  const emoji = theme.emoji || "💡";
  // 홀수 개수면 마지막 카드는 가운데 정렬 (빈 칸 방지)
  const cellPos = (i) => {
    const lastOdd = places.length % 2 === 1 && i === places.length - 1;
    const col = i % 2, row = Math.floor(i / 2);
    return { x: lastOdd ? (W - CELL_W) / 2 : col * CELL_W, y: HEADER + row * CELL_H };
  };

  const photoLayers = [];
  const cellBufs = {};
  for (let i = 0; i < places.length; i++) {
    try {
      const res = await fetch(places[i].imageUrl, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      cellBufs[i] = buf;
      const { x, y } = cellPos(i);
      const resized = await sharp(buf)
        .resize(PHOTO_W, CELL_H - PAD * 2, { fit: "cover" })
        .jpeg({ quality: 82 })
        .toBuffer();
      photoLayers.push({
        input: resized,
        left: x + CELL_W - PHOTO_W - PAD,
        top: y + PAD,
      });
    } catch { /* 사진 실패 시 텍스트만 */ }
  }

  // 헤더 양옆 원형 음식 사진 (음식으로 판별된 사진 우선)
  const D = 128, RING_Y = 26;
  const headerPickIdx = places
    .map((p, i) => ({ i, food: !!p.foodPicked }))
    .filter((v) => cellBufs[v.i])
    .sort((a, b) => Number(b.food) - Number(a.food))
    .slice(0, 2)
    .map((v) => v.i);
  const circleMask = Buffer.from(
    `<svg width="${D}" height="${D}"><circle cx="${D / 2}" cy="${D / 2}" r="${D / 2}" fill="#fff"/></svg>`
  );
  const headerPos = [{ left: 48 }, { left: W - 48 - D }];
  for (let k = 0; k < headerPickIdx.length; k++) {
    try {
      const circ = await sharp(cellBufs[headerPickIdx[k]])
        .resize(D, D, { fit: "cover" })
        .composite([{ input: circleMask, blend: "dest-in" }])
        .png()
        .toBuffer();
      photoLayers.push({ input: circ, left: headerPos[k].left, top: RING_Y });
    } catch { /* 없어도 무방 */ }
  }

  let bgCells = "", textCells = "";
  for (let i = 0; i < places.length; i++) {
    const p = places[i];
    const { x, y } = cellPos(i);
    const nm = p.name.length > 13 ? p.name.slice(0, 12) + "…" : p.name;
    const ns = nm.length <= 7 ? 30 : nm.length <= 9 ? 25 : 20;
    const d1 = (p.desc ?? "").slice(0, 12), d2 = (p.desc ?? "").slice(12, 24);
    const chipW = p.region.length * 20 + 46;
    bgCells += `<rect x="${x + 8}" y="${y + 6}" width="${CELL_W - 16}" height="${CELL_H - 12}" rx="16" fill="white" stroke="#f1dede" stroke-width="2"/>`;
    textCells += `
    <g>
      <rect x="${x + PAD + 8}" y="${y + PAD + 10}" width="44" height="44" rx="12" fill="#d92121"/>
      <text x="${x + PAD + 30}" y="${y + PAD + 42}" font-family="${FONT}" font-size="28" font-weight="800" fill="#fff" text-anchor="middle">${i + 1}</text>
      <text x="${x + PAD + 62}" y="${y + PAD + 40}" font-family="${FONT}" font-size="${ns}" font-weight="800" fill="#b81414">${esc(nm)}</text>
      <rect x="${x + PAD + 8}" y="${y + PAD + 58}" width="${chipW}" height="34" rx="17" fill="#f6ede7"/>
      <text x="${x + PAD + 8 + chipW / 2}" y="${y + PAD + 82}" font-family="${FONT}" font-size="20" font-weight="700" fill="#8a5a44" text-anchor="middle">📍 ${esc(p.region)}</text>
      ${p.hundred ? `<rect x="${x + PAD + 8 + chipW + 8}" y="${y + PAD + 58}" width="110" height="34" rx="17" fill="#fff3d6" stroke="#e8c66a" stroke-width="1.5"/>
      <text x="${x + PAD + 8 + chipW + 63}" y="${y + PAD + 82}" font-family="${FONT}" font-size="19" font-weight="800" fill="#9a7419" text-anchor="middle">백년가게</text>` : ""}
      <text x="${x + PAD + 10}" y="${y + PAD + 128}" font-family="${FONT}" font-size="22" fill="#333">${emoji} ${esc(d1)}</text>
      ${d2 ? `<text x="${x + PAD + 10}" y="${y + PAD + 158}" font-family="${FONT}" font-size="22" fill="#333">${esc(d2)}</text>` : ""}
    </g>`;
  }

  const titleText = String(theme.titleResolved || theme.title);
  const titleSize = titleText.length <= 11 ? 58 : titleText.length <= 14 ? 50 : 43;
  const bgSvg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <rect x="0" y="0" width="${W}" height="${HEADER}" fill="#d92121"/>
    <text x="${W / 2}" y="80" font-family="${FONT}" font-size="${titleSize}" font-weight="900" fill="#ffffff" text-anchor="middle">${esc(titleText)}</text>
    <text x="${W / 2}" y="138" font-family="${FONT}" font-size="25" font-weight="600" fill="#ffd9d9" text-anchor="middle">✦ 저장해두고 하나씩 정복해 보세요 ✦</text>
    ${bgCells}
    <rect x="0" y="${H - FOOTER}" width="${W}" height="${FOOTER}" fill="#2b2323"/>
    <text x="${W / 2}" y="${H - FOOTER + 38}" font-family="${FONT}" font-size="25" font-weight="700" fill="#ffffff" text-anchor="middle">여러분의 추천 맛집도 댓글로 남겨주세요 💬</text>
    <text x="${W / 2}" y="${H - FOOTER + 68}" font-family="${FONT}" font-size="21" fill="#c9b8b8" text-anchor="middle">@${HANDLE}</text>
  </svg>`;
  // 헤더 원형 사진 흰 테두리 (사진 위에 그려짐)
  const rings = headerPickIdx
    .map((_, k) => `<circle cx="${headerPos[k].left + D / 2}" cy="${RING_Y + D / 2}" r="${D / 2 + 3}" fill="none" stroke="#ffffff" stroke-width="6"/>`)
    .join("");
  const textSvg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${rings}${textCells}</svg>`;

  const out = path.join(TMP, "cover.jpg");
  await sharp({ create: { width: W, height: H, channels: 3, background: "#fdf6f2" } })
    .composite([
      { input: Buffer.from(bgSvg), left: 0, top: 0 },
      ...photoLayers,
      { input: Buffer.from(textSvg), left: 0, top: 0 },
    ])
    .jpeg({ quality: 88 })
    .toFile(out);
  console.log(`표지 합성 완료: ${places.length}곳, ${W}x${H}`);
  return out;
}

/** 뒷장 상세 슬라이드: 사진(1080x1350) + 하단 이름·지역·상세설명 바 합성 */
async function composeSlide(place, rank) {
  const sharp = (await import("sharp")).default;
  const W = 1080, H = 1350, BAR = 250;
  const res = await fetch(place.imageUrl, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error("slide img http " + res.status);
  const photo = await sharp(Buffer.from(await res.arrayBuffer()))
    .resize(W, H, { fit: "cover" })
    .jpeg({ quality: 85 })
    .toBuffer();
  const nm = place.name.length > 15 ? place.name.slice(0, 14) + "…" : place.name;
  const ns = nm.length <= 9 ? 44 : nm.length <= 12 ? 36 : 30;
  // 상세 설명 2줄 래핑 (한 줄 최대 22자)
  const detail = String(place.detail ?? "");
  const d1 = detail.slice(0, 22), d2 = detail.slice(22, 44);
  const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <rect x="0" y="${H - BAR}" width="${W}" height="${BAR}" fill="#000000" fill-opacity="0.66"/>
    <rect x="28" y="${H - BAR + 30}" width="64" height="64" rx="16" fill="#d92121"/>
    <text x="60" y="${H - BAR + 75}" font-family="${FONT}" font-size="38" font-weight="800" fill="#fff" text-anchor="middle">${rank}</text>
    <text x="116" y="${H - BAR + 60}" font-family="${FONT}" font-size="${ns}" font-weight="800" fill="#ffffff">${esc(nm)}</text>
    <text x="116" y="${H - BAR + 100}" font-family="${FONT}" font-size="26" fill="#e5d8d8">📍 ${esc(place.region)}${place.hundred ? " · 백년가게 인증" : ""}</text>
    <text x="44" y="${H - BAR + 158}" font-family="${FONT}" font-size="29" font-weight="600" fill="#ffffff">${esc(d1)}</text>
    ${d2 ? `<text x="44" y="${H - BAR + 202}" font-family="${FONT}" font-size="29" font-weight="600" fill="#ffffff">${esc(d2)}</text>` : ""}
  </svg>`;
  const out = path.join(TMP, `slide_${rank}.jpg`);
  await sharp(photo).composite([{ input: Buffer.from(svg), left: 0, top: 0 }]).jpeg({ quality: 86 }).toFile(out);
  return out;
}

/** 받침 유무 조사 선택 */
function josa(word, withBatchim, without) {
  const code = word.charCodeAt(word.length - 1);
  if (code < 0xac00 || code > 0xd7a3) return withBatchim;
  return (code - 0xac00) % 28 > 0 ? withBatchim : without;
}

/** 댓글 참여 유도 문구 (전부 "추천 맛집 댓글로" 뉘앙스, 랜덤 회전) */
function engagementLine(theme, count) {
  const spot = theme.keyword === "카페" ? "카페" : `${theme.keyword} 맛집`;
  const pool = [
    `여러분의 인생 ${spot}${josa(spot, "은", "는")} 어디인가요? 추천 맛집을 댓글로 남겨주세요 🙌`,
    `우리 동네 ${spot}${josa(spot, "이", "가")} 최고다! 하시는 분들, 그 집을 댓글로 추천해 주세요 🔥`,
    `이 리스트에 없는 숨은 명가가 있다면, 여러분이 아는 진짜 ${theme.keyword} 성지를 댓글로 추천해 주세요 👀`,
    `1~${count}번 중 가보신 곳 있나요? 후기와 함께 여러분만의 추천 맛집도 댓글로 남겨주세요 🙋`,
    `같이 가고 싶은 사람을 댓글에 태그해 보세요 🤝 여러분만 아는 추천 ${spot}도 댓글로 남겨주시면 최고예요!`,
    `댓글로 추천해 주신 곳은 다음 모음집 후보에 올려드려요! 여러분의 원픽 ${spot}${josa(spot, "을", "를")} 댓글로 추천해 주세요 ✍️`,
  ];
  return pool[Math.floor(Math.random() * pool.length)];
}

function buildCaption(theme, places, descending = false) {
  // 공개형 — "어디야→DM" 유도 문구 없음. 참여(추천 댓글)·저장 유도만.
  // descending: 카운트다운 영상과 같은 순서(N위 → 1위)로 번호를 매긴다.
  const lines = places.map((p, i) => {
    const num = descending ? places.length - i : i + 1;
    return `${num}. ${p.name}${p.hundred ? " 🏅" : ""} (${p.region}) — ${p.desc}`;
  });
  const hundredCount = places.filter((p) => p.hundred).length;
  const hundredLine =
    hundredCount > 0
      ? `🏅 표시된 ${hundredCount}곳은 중소벤처기업부 인증 '백년가게'예요!\n\n`
      : "";
  const tags = [...(theme.tags ?? []), "맛집추천", "맛집리스트", "먹스타그램", "저장각", "맛집투어"]
    .map((t) => `#${t}`)
    .join(" ");
  return (
    `🔥 ${theme.titleResolved || theme.title}\n\n` +
    `${lines.join("\n")}\n\n` +
    hundredLine +
    `💬 ${engagementLine(theme, places.length)}\n\n` +
    `📌 저장해두고 하나씩 정복해 보세요!\n\n` +
    `${tags}\n\n📷 사진·정보 출처: 한국관광공사 TourAPI`
  );
}

async function main() {
  const { db, initDb } = await import("../lib/db.ts");
  const themesData = JSON.parse(
    fs.readFileSync(new URL("../data/roundup-themes.json", import.meta.url), "utf8")
  );
  await initDb();

  // 발행 쿨다운(행동차단 회복) 중이면 모음집도 쉼 — 시도 반복이 차단을 연장시킴
  if (!DRY) {
    const cd = await db.execute("SELECT value FROM config WHERE key='publish_cooldown_until'");
    if (cd.rows.length > 0) {
      const until = new Date(String(cd.rows[0].value).replace(" ", "T") + "Z").getTime();
      if (Date.now() < until) {
        console.log("발행 쿨다운 중 — 모음집 건너뜀 (" + Math.round((until-Date.now())/60000) + "분 남음)");
        return;
      }
    }
  }

  // 테마 선택: 단순 로테이션 (포인터 순서대로, 수집 부족 시 다음 테마)
  // 모음집(grid)과 큐레이션(countdown)은 포인터를 따로 둬 같은 테마가 겹치지 않게 함
  const IDX_KEY = process.env.ROUNDUP_STYLE === "countdown" ? "countdown_idx" : "roundup_idx";
  const idxRow = await db.execute({
    sql: "SELECT value FROM config WHERE key = ?",
    args: [IDX_KEY],
  });
  const idx = idxRow.rows.length ? Number(idxRow.rows[0].value) : 0;
  const all = themesData.themes;
  const ordered = all.map((_, i) => all[(idx + i) % all.length]);

  let theme = null, places = [];
  for (let t = 0; t < Math.min(3, ordered.length); t++) {
    const cand = ordered[t];
    const got = await collectPlaces(cand);
    console.log(`[${cand.key}] 수집: ${got.length}곳 (목표 ${cand.count})`);
    if (got.length >= Math.min(6, cand.count)) { // 6곳 이상이면 발행(8곳 상한)
      theme = cand;
      places = got.slice(0, cand.count);
      // 표지 그리드는 2열이라 홀수면 마지막 칸이 혼자 남아 비대칭 → 항상 짝수로 맞춤
      if (places.length % 2 === 1) places = places.slice(0, -1);
      break;
    }
  }
  if (!theme) throw new Error("수집 가능한 테마 없음");
  // 자극형 제목 랜덤 생성 ("9대 맛집", "레전드 9선", "맛도리", "TOP 9" 등)
  theme.titleResolved = buildPunchyTitle(theme, places.length);
  console.log("제목:", theme.titleResolved);

  // 백년가게 대조 (배지·캡션용)
  await markHundredYear(db, places);
  console.log(`백년가게: ${places.filter((p) => p.hundred).length}곳`);

  // 한줄평+상세설명 먼저 (비전 호출이 분당 한도를 소모하기 전에)
  // 모든 AI(Gemini→Groq)가 실패하면 저품질 기본 문구로 내보내지 않고 발행 자체를 건너뜀
  const descs = await makeDescriptions(theme, places);
  if (!descs) {
    console.log("⏭️ AI 한도 소진 (Gemini/Groq 모두 실패) — 이번 모음집 발행 건너뜀");
    return;
  }
  places.forEach((p, i) => {
    p.desc = descs[i].short;
    p.detail = descs[i].detail;
  });

  // 음식 사진 우선 선택 (Gemini 비전) — 무료 등급 분당 한도 고려해 4초 간격 순차
  for (const p of places) {
    await pickFoodImage(p);
    await new Promise((r) => setTimeout(r, 4000));
  }
  console.log(`음식 사진 교체: ${places.filter((p) => p.foodPicked).length}/${places.length}곳`);

  // 발행 스타일
  //  - grid(기본): 기존 모음집 — 리스트 인포그래픽 한 장을 릴스로
  //  - countdown: 큐레이션 — 인트로 + 순위 카드 순차 공개 + 아웃트로 (1위 보려고 끝까지 봄)
  const STYLE = process.env.ROUNDUP_STYLE === "countdown" ? "countdown" : "grid";
  const sharpMod = (await import("sharp")).default;

  // 순위 근거: 네이버 '블로그 후기 수'. 실제 방문·후기가 많을수록 인기 있는 집이라
  // 임의 순서가 아닌 근거 있는 랭킹이 된다. (데이터랩은 신규 등록이 막혀 사용 불가)
  // 키가 없거나 실패하면 수집 순서를 그대로 쓴다.
  let rankBasis = "";
  if (STYLE === "countdown") {
    try {
      const { rankByBuzz } = await import("../lib/naver.ts");
      const res = await rankByBuzz(places);
      if (res?.scored) {
        places = res.ranked; // 1위가 앞
        rankBasis = "블로그 후기";
        console.log(
          "후기 수 기준 순위:",
          places.map((p) => `${p.name}(${p.buzz})`).join(" > ")
        );
      } else {
        console.log("후기 데이터 없음 — 수집 순서 사용");
      }
    } catch (e) {
      console.error("후기 랭킹 실패(수집 순서 사용):", String(e).slice(0, 100));
    }
  }
  // 카운트다운은 릴스 완주율을 위해 상위 5곳만 쓴다(8곳이면 45초+로 길어져 이탈).
  // 8곳을 수집한 뒤 후기순 상위 5곳을 고르는 것이라 오히려 품질은 올라간다.
  if (STYLE === "countdown" && places.length > 5) {
    places = places.slice(0, 5);
    theme.titleResolved = buildPunchyTitle(theme, places.length);
    console.log(`TOP 5로 축소 → ${theme.titleResolved}`);
  }

  // 카운트다운은 '아래 순위 → 1위' 순으로 뒤집어 공개
  const ranked = STYLE === "countdown" ? [...places].reverse() : places;

  // ⚠️ 캡션은 순위가 확정된 뒤에 만든다(정렬 전에 만들면 번호가 영상과 어긋남).
  //    카운트다운은 영상과 같은 순서로 N위 → 1위 내림차순 표기.
  const caption =
    STYLE === "countdown"
      ? buildCaption(theme, ranked, true)
      : buildCaption(theme, places);

  const cards = []; // countdown에서 쓸 카드 파일들
  const narration = []; // 카드와 1:1 대응하는 나레이션 문장
  let reelCover = null;
  if (STYLE === "countdown") {
    const intro = path.join(TMP, "c_intro.jpg");
    fs.writeFileSync(
      intro,
      await composeIntroCard(sharpMod, theme, places, theme.titleResolved, rankBasis)
    );
    cards.push(intro);
    narration.push(`${theme.titleResolved}. ${ranked.length}위부터 공개합니다`);

    for (let i = 0; i < ranked.length; i++) {
      const rank = ranked.length - i; // N위 → 1위
      const f = path.join(TMP, `c_rank_${rank}.jpg`);
      try {
        fs.writeFileSync(f, await composeRankCard(sharpMod, ranked[i], rank));
        cards.push(f);
        const p = ranked[i];
        const tail = p.desc ? `. ${p.desc}` : "";
        narration.push(
          rank === 1
            ? `대망의 1위, ${p.region ? p.region + " " : ""}${p.name}${tail}`
            : `${rank}위, ${p.region ? p.region + " " : ""}${p.name}${tail}`
        );
      } catch (e) {
        console.error(`순위 카드 ${rank} 실패(건너뜀):`, String(e).slice(0, 90));
      }
    }
    const outro = path.join(TMP, "c_outro.jpg");
    try {
      fs.writeFileSync(outro, await composeOutroCard(sharpMod, places, theme.titleResolved));
      cards.push(outro);
      narration.push("저장해두고 하나씩 가보세요");
    } catch { /* 아웃트로는 없어도 됨 */ }
    console.log(`카운트다운 카드 ${cards.length}장 생성`);
  } else {
    reelCover = await composeReelCover(theme, places);
  }

  if (DRY) {
    if (STYLE === "countdown") {
      fs.copyFileSync(cards[0], "countdown-intro-preview.jpg");
      if (cards[1]) fs.copyFileSync(cards[1], "countdown-rank-preview.jpg");
      console.log("DRY — countdown-intro-preview.jpg / countdown-rank-preview.jpg 저장");
    } else {
      fs.copyFileSync(reelCover, "roundup-reel-preview.jpg");
      console.log("DRY 모드 — 발행 생략. roundup-reel-preview.jpg 저장");
    }
    console.log(caption);
    return;
  }

  // 중복발행 방지: 오늘 같은 테마가 이미 발행됐으면 스킵 + 발행 '전에' 마커 선기록.
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const cid = `${STYLE === "countdown" ? "countdown" : "roundup"}-${theme.key}-${today}`;
  const dup = await db.execute({ sql: "SELECT 1 FROM posts WHERE content_id = ?", args: [cid] });
  if (dup.rows.length) {
    console.log("오늘 이미 발행된 테마 — 스킵:", cid);
    return;
  }
  await db.execute({
    sql: `INSERT INTO posts (content_id, place_name, address, category, image_url, caption, status)
          VALUES (?, ?, ?, '모음집', ?, ?, 'publishing')`,
    args: [
      cid,
      theme.titleResolved,
      places.map((p, i) => `${i + 1}. ${p.name} — ${p.address}`).join("\n"),
      places[0].imageUrl,
      caption,
    ],
  });

  const reelMp4 = path.join(TMP, "roundup-reel.mp4");
  const ff = (args) =>
    new Promise((resolve, reject) => {
      const p = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "inherit"] });
      p.on("error", reject);
      p.on("close", (c) => (c === 0 ? resolve() : reject(new Error("ffmpeg exit " + c))));
    });

  if (STYLE === "countdown") {
    // 카드들을 순서대로 이어붙임 (인트로 3초, 순위 카드 2.6초, 아웃트로 2.6초)
    // 나레이션 음성 — TTS는 릴스당 1회만 호출(무료 한도 보호). 실패하면 무음 진행.
    const persona = JSON.parse(
      fs.readFileSync(new URL("../data/persona.json", import.meta.url), "utf8")
    );
    const { ttsPcm, ttsVoiceConfig } = await import("../lib/tts.ts");
    const vc = ttsVoiceConfig(persona);
    let voiceWav = null;
    let voiceDur = 0;
    try {
      const r = await ttsPcm(narration.join("\n"), { voice: vc.voice, direction: vc.direction });
      if (r) {
        const pcm = path.join(TMP, "c_voice.pcm");
        fs.writeFileSync(pcm, r.pcm);
        const wav = path.join(TMP, "c_voice.wav");
        const args = ["-y", "-f", "s16le", "-ar", String(r.rate), "-ac", "1", "-i", pcm];
        const tempo = Math.min(Math.max(vc.speed, 0.5), 2);
        if (Math.abs(tempo - 1) > 0.01) args.push("-filter:a", `atempo=${tempo.toFixed(2)}`);
        args.push(wav);
        await ff(args);
        voiceDur = await probeDuration(wav);
        if (voiceDur > 1) voiceWav = wav;
      }
    } catch (e) {
      console.error("나레이션 생성 실패(무음 진행):", String(e).slice(0, 100));
    }
    console.log(voiceWav ? `나레이션 ${narration.length}문장 (${voiceDur.toFixed(1)}초)` : "나레이션 없음 — 무음");

    // 컷 길이: 음성이 있으면 문장 길이 비율로 배분해 화면과 말이 맞게 함
    const weights = narration.map((s) => Math.max(s.length, 8));
    const wsum = weights.reduce((a, b) => a + b, 0) || 1;

    const clips = [];
    for (let i = 0; i < cards.length; i++) {
      const secs = voiceWav
        ? Math.max((voiceDur * (weights[i] ?? 1)) / wsum, 1.4)
        : i === 0 ? 3.0 : 2.6;
      const out = path.join(TMP, `c_clip_${i}.mp4`);
      const d = Math.round(secs * 30);
      await ff([
        "-y", "-loop", "1", "-i", cards[i], "-t", String(secs.toFixed(2)), "-r", "30",
        "-vf",
        `scale=3240:5760:flags=lanczos,zoompan=z='min(zoom+0.0005,1.10)':d=${d}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1080x1920:fps=30,format=yuv420p`,
        "-c:v", "libx264", "-preset", "veryfast", out,
      ]);
      clips.push(out);
    }
    const listFile = path.join(TMP, "c_list.txt");
    fs.writeFileSync(listFile, clips.map((c) => `file '${c}'`).join("\n"));
    const silent = path.join(TMP, "c_silent.mp4");
    await ff([
      "-y", "-f", "concat", "-safe", "0", "-i", listFile,
      "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", silent,
    ]);
    if (voiceWav) {
      await ff([
        "-y", "-i", silent, "-i", voiceWav,
        "-c:v", "copy", "-c:a", "aac", "-b:a", "128k",
        "-movflags", "+faststart", reelMp4,
      ]);
    } else {
      await ff([
        "-y", "-i", silent,
        "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
        "-c:v", "copy", "-c:a", "aac", "-shortest", "-movflags", "+faststart", reelMp4,
      ]);
    }
    console.log(`카운트다운 릴스 렌더 완료 (${clips.length}컷${voiceWav ? ", 음성 포함" : ""})`);
  } else {
    // 리스트 표지 → 잔잔한 줌인 8초 세로 릴스 렌더 (기존 모음집)
    await ff([
      "-y", "-loop", "1", "-i", reelCover, "-t", "8", "-r", "30",
      "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
      "-filter_complex",
      "[0:v]scale=3240:5760:flags=lanczos,zoompan=z='min(zoom+0.00025,1.20)':d=240:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1080x1920:fps=30,format=yuv420p[v]",
      "-map", "[v]", "-map", "1:a",
      "-c:v", "libx264", "-preset", "veryfast", "-c:a", "aac", "-shortest",
      "-movflags", "+faststart", reelMp4,
    ]);
  }

  const reelUrl = await uploadPublic(reelMp4);
  console.log("모음집 릴스 업로드:", reelUrl);
  const { publishReel } = await import("../lib/instagram.ts");
  const mediaId = await publishReel(reelUrl, caption);
  console.log("✅ 모음집 릴스 발행:", mediaId);
  await db.execute({
    sql: `UPDATE posts SET ig_media_id = ?, status = 'published' WHERE content_id = ?`,
    args: [mediaId, cid],
  });

  // 포인터 이동 (계절 스킵돼도 로테이션 유지)
  const chosenIdx = all.findIndex((t) => t.key === theme.key);
  await db.execute({
    sql: "INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))",
    args: [IDX_KEY, String((chosenIdx + 1) % all.length)],
  });

  console.log("완료:", theme.titleResolved);
}

/** 미디어 길이(초) — ffprobe. 실패하면 0 */
function probeDuration(file) {
  return new Promise((resolve) => {
    const p = spawn("ffprobe", [
      "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file,
    ]);
    let out = "";
    p.on("error", () => resolve(0));
    p.stdout.on("data", (d) => (out += d));
    p.on("close", () => resolve(Number(String(out).trim()) || 0));
  });
}

function curlUpload(args) {
  return new Promise((resolve, reject) => {
    const p = spawn("curl", ["-s", "--max-time", "120", ...args]);
    p.on("error", reject); // spawn 실패 시 Promise가 안 끝나는 것 방지
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("close", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`curl exit ${code}`))));
  });
}

/** 공개 URL 업로드 폴백 체인 (Blob → tmpfiles → catbox) */
async function uploadPublic(filePath) {
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    try {
      const { put } = await import("@vercel/blob");
      const res = await put(`roundups/${Date.now()}-${path.basename(filePath)}`, fs.readFileSync(filePath), {
        access: "public", contentType: "image/jpeg", token: process.env.BLOB_READ_WRITE_TOKEN,
      });
      return res.url;
    } catch (e) {
      console.error("Vercel Blob 실패, 다음 폴백:", String(e).slice(0, 150));
    }
  }
  try {
    const out = await curlUpload(["-F", `file=@${filePath}`, "https://tmpfiles.org/api/v1/upload"]);
    const pageUrl = JSON.parse(out)?.data?.url?.replace("tmpfiles.org/", "tmpfiles.org/dl/");
    if (pageUrl) {
      const html = await fetch(pageUrl, { signal: AbortSignal.timeout(20000) }).then((r) => r.text());
      const m = html.match(/href="(https:\/\/tmpfiles\.org\/dl\/[^"]+\.(?:jpg|jpeg|png|mp4))"/);
      if (m) return m[1];
    }
  } catch (e) {
    console.error("tmpfiles 실패, 다음 폴백:", String(e).slice(0, 150));
  }
  const out = await curlUpload([
    "-F", "reqtype=fileupload", "-F", "userhash=", "-F", `fileToUpload=@${filePath}`,
    "https://catbox.moe/user/api.php",
  ]);
  if (out.startsWith("http")) return out;
  throw new Error("모든 업로드 실패: " + out.slice(0, 200));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("모음집 실패:", e);
    process.exit(1);
  });
