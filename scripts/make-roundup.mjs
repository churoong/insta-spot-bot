// 모음집(공개형 N선) 자동 생성·발행 — GitHub Actions에서 실행.
// 흐름: 테마 로테이션 → TourAPI 검색으로 식당 수집(사진·공공누리 확인) →
//       Gemini 한줄평 → sharp로 표지 인포그래픽 합성 → 표지+사진 캐러셀 발행 → Turso 기록.
//
// 필요한 환경변수: TOUR_API_KEY, GEMINI_API_KEY, GEMINI_MODEL,
//   TURSO_DATABASE_URL, TURSO_AUTH_TOKEN, IG_USER_ID, IG_ACCESS_TOKEN
//   (선택) BLOB_READ_WRITE_TOKEN, ROUNDUP_DRY=1(발행 없이 이미지 파일만 생성)

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "roundup-"));
const TOUR = "https://apis.data.go.kr/B551011/KorService2";
const DRY = process.env.ROUNDUP_DRY === "1";

const SIDO_SHORT = {
  서울특별시: "서울", 부산광역시: "부산", 대구광역시: "대구", 인천광역시: "인천",
  광주광역시: "광주", 대전광역시: "대전", 울산광역시: "울산", 세종특별자치시: "세종",
  경기도: "경기", 강원도: "강원", 강원특별자치도: "강원",
  충청북도: "충북", 충청남도: "충남", 전라북도: "전북", 전북특별자치도: "전북",
  전라남도: "전남", 경상북도: "경북", 경상남도: "경남",
  제주특별자치도: "제주", 제주도: "제주",
};

function shortRegion(addr) {
  const parts = String(addr ?? "").split(/\s+/);
  const sido = SIDO_SHORT[parts[0]] ?? (parts[0] ?? "").slice(0, 2);
  const gu = (parts[1] ?? "").replace(/(특별자치)?(시|군|구)$/, "");
  return [sido, gu].filter(Boolean).join(" ");
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function tourCall(endpoint, params) {
  const qs = new URLSearchParams({
    serviceKey: process.env.TOUR_API_KEY,
    MobileOS: "ETC", MobileApp: "instaSpotBot", _type: "json", ...params,
  });
  const res = await fetch(`${TOUR}/${endpoint}?${qs}`, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`TourAPI ${endpoint} HTTP ${res.status}`);
  const json = await res.json();
  const items = json?.response?.body?.items?.item;
  return Array.isArray(items) ? items : items ? [items] : [];
}

/** 테마에 맞는 식당 수집 (사진 + 공공누리 Type1/3) */
async function collectPlaces(theme) {
  const params = { keyword: theme.keyword, contentTypeId: "39", numOfRows: "100", arrange: "R" };
  if (theme.areaCode) params.areaCode = String(theme.areaCode);
  let items = await tourCall("searchKeyword2", params);
  items = items.filter(
    (it) => it.firstimage && (it.cpyrhtDivCd === "Type1" || it.cpyrhtDivCd === "Type3")
  );
  // 지역 다양성: 같은 시군구 최대 2곳
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
      imageUrl: String(it.firstimage).replace(/^http:/, "https:"),
    });
    if (picked.length >= theme.count) break;
  }
  return picked;
}

const BAD_IMG_NAME =
  /(화장실|주차|기저귀|수유|경사로|안내도|안내판|표지판|매표|엘리베이터|승강기|휠체어|점자|유도블록|소화전|진입로|비상|피난|보관함|안내소|계산대)/;

const toHttps = (u) => String(u ?? "").replace(/^http:/, "https:");

/**
 * 가게별 이미지 목록에서 Gemini 비전으로 "음식 사진"을 골라 대표 이미지 교체.
 * 실패하면 기존 대표 이미지 유지 (무해한 폴백).
 */
async function pickFoodImage(place) {
  try {
    const items = await tourCall("detailImage2", {
      contentId: place.contentId,
      imageYN: "Y",
      numOfRows: "15",
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

    // 썸네일 다운로드 → base64 (판별용이라 작은 이미지면 충분)
    const valid = [], parts = [];
    for (const c of cands) {
      try {
        const res = await fetch(c.small, { signal: AbortSignal.timeout(15000) });
        if (!res.ok) continue;
        const b = Buffer.from(await res.arrayBuffer());
        if (b.length > 900_000) continue;
        valid.push(c);
        parts.push({ inlineData: { mimeType: "image/jpeg", data: b.toString("base64") } });
      } catch {
        /* skip */
      }
    }
    if (valid.length <= 1) return;

    const model = process.env.GEMINI_MODEL || "gemini-flash-latest";
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text: `식당 사진 ${valid.length}장이야. 음식(요리·메뉴)이 크고 먹음직스럽게 보이는 사진의 번호를 좋은 순서대로 JSON 배열로만 답해 (1번부터). 건물 외관·간판·내부 전경은 제외. 음식 사진이 없으면 []. 예: [3,1]`,
                },
                ...parts,
              ],
            },
          ],
          generationConfig: { maxOutputTokens: 60, thinkingConfig: { thinkingBudget: 0 } },
        }),
        signal: AbortSignal.timeout(40000),
      }
    );
    const json = await res.json();
    const text = json?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    const m = text.match(/\[[\d,\s]*\]/);
    const order = m ? JSON.parse(m[0]) : [];
    const best = order.length ? valid[Number(order[0]) - 1] : null;
    if (best?.url) {
      place.imageUrl = best.url;
      place.foodPicked = true;
    }
  } catch {
    /* 실패 시 기존 이미지 유지 */
  }
}

/** Gemini로 한줄평 생성 (실패 시 기본 문구) */
async function makeDescriptions(theme, places) {
  const fallback = places.map(() => "현지에서 오래 사랑받아온 곳");
  if (!process.env.GEMINI_API_KEY) return fallback;
  try {
    const model = process.env.GEMINI_MODEL || "gemini-flash-latest";
    const prompt = `"${theme.title}" 인스타 카드뉴스용 한줄평을 만들어줘.
식당 목록:
${places.map((p, i) => `${i + 1}. ${p.name} (${p.region})`).join("\n")}

규칙: 각 식당마다 ${theme.keyword} 메뉴 특징을 살린 짧은 한줄평(10~16자, 존댓말 아님, 명사형 종결. 예: "깊고 깔끔한 사골국물", "쫄깃한 수제 면발"). 상호명 반복 금지. 과장·허위 금지(일반적 묘사만).
JSON 배열만 출력: ["...","..."] (${places.length}개)`;
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 800, thinkingConfig: { thinkingBudget: 0 } },
        }),
        signal: AbortSignal.timeout(30000),
      }
    );
    const json = await res.json();
    const text = json?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    const m = text.match(/\[[\s\S]*\]/);
    if (!m) return fallback;
    const arr = JSON.parse(m[0]);
    if (!Array.isArray(arr)) return fallback;
    return places.map((_, i) => String(arr[i] ?? fallback[i]).slice(0, 22));
  } catch {
    return fallback;
  }
}

/** 표지 인포그래픽 합성 (sharp, 1080xH) */
async function composeCover(theme, places) {
  const sharp = (await import("sharp")).default;
  const W = 1080, HEADER = 170;
  const rows = Math.ceil(places.length / 2);
  const CELL_W = 540, CELL_H = Math.max(210, Math.floor(1180 / rows));
  const H = HEADER + CELL_H * rows;
  const PHOTO_W = 225, PAD = 12;
  const FONT = "'Noto Sans CJK KR','NanumGothic','Malgun Gothic',sans-serif";

  // 사진 다운로드·리사이즈
  const photoLayers = [];
  for (let i = 0; i < places.length; i++) {
    try {
      const res = await fetch(places[i].imageUrl, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error("img http " + res.status);
      const buf = Buffer.from(await res.arrayBuffer());
      const col = i % 2, row = Math.floor(i / 2);
      const resized = await sharp(buf)
        .resize(PHOTO_W, CELL_H - PAD * 2, { fit: "cover" })
        .jpeg({ quality: 82 })
        .toBuffer();
      photoLayers.push({
        input: resized,
        left: col * CELL_W + CELL_W - PHOTO_W - PAD,
        top: HEADER + row * CELL_H + PAD,
      });
    } catch {
      /* 사진 실패 시 그 칸은 텍스트만 */
    }
  }

  // 레이어 구성: ① 카드 배경 SVG → ② 사진 → ③ 텍스트 SVG (사진이 가려지지 않게 분리)
  let bgCells = "", textCells = "";
  for (let i = 0; i < places.length; i++) {
    const p = places[i];
    const col = i % 2, row = Math.floor(i / 2);
    const x = col * CELL_W, y = HEADER + row * CELL_H;
    // 이름이 사진 영역(약 230px)을 넘지 않게 글자 크기 조절 + 말줄임
    const rawName = p.name.length > 13 ? p.name.slice(0, 12) + "…" : p.name;
    const nameSize = rawName.length <= 7 ? 31 : rawName.length <= 9 ? 26 : 20;
    p.displayName = rawName;
    const desc = p.desc ?? "";
    const d1 = desc.slice(0, 12), d2 = desc.slice(12, 24);
    bgCells += `<rect x="${x + 8}" y="${y + 6}" width="${CELL_W - 16}" height="${CELL_H - 12}" rx="14" fill="white" stroke="#eee2e2" stroke-width="2"/>`;
    textCells += `
    <g>
      <rect x="${x + PAD + 8}" y="${y + PAD + 10}" width="44" height="44" rx="10" fill="#d92121"/>
      <text x="${x + PAD + 30}" y="${y + PAD + 42}" font-family="${FONT}" font-size="28" font-weight="700" fill="#fff" text-anchor="middle">${i + 1}</text>
      <text x="${x + PAD + 62}" y="${y + PAD + 40}" font-family="${FONT}" font-size="${nameSize}" font-weight="700" fill="#b81414">${esc(p.displayName)}</text>
      <text x="${x + PAD + 10}" y="${y + PAD + 82}" font-family="${FONT}" font-size="23" font-weight="600" fill="#666">(${esc(p.region)})</text>
      <text x="${x + PAD + 10}" y="${y + PAD + 122}" font-family="${FONT}" font-size="22" fill="#333">💡 ${esc(d1)}</text>
      ${d2 ? `<text x="${x + PAD + 10}" y="${y + PAD + 152}" font-family="${FONT}" font-size="22" fill="#333">${esc(d2)}</text>` : ""}
    </g>`;
  }
  const bgSvg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <rect x="0" y="0" width="${W}" height="${HEADER}" fill="#fff"/>
    <text x="${W / 2}" y="105" font-family="${FONT}" font-size="64" font-weight="800" fill="#d92121" text-anchor="middle">✦ ${esc(theme.title)} ✦</text>
    <rect x="60" y="140" width="${W - 120}" height="5" fill="#d92121"/>
    ${bgCells}
  </svg>`;
  const textSvg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${textCells}</svg>`;

  const out = path.join(TMP, "cover.jpg");
  await sharp({ create: { width: W, height: H, channels: 3, background: "#fdf8f4" } })
    .composite([
      { input: Buffer.from(bgSvg), left: 0, top: 0 },
      ...photoLayers,
      { input: Buffer.from(textSvg), left: 0, top: 0 },
    ])
    .jpeg({ quality: 88 })
    .toFile(out);
  console.log(`표지 합성 완료: ${out} (${places.length}곳, ${W}x${H})`);
  return out;
}

/** 받침 유무에 따른 조사 선택 (맛집→은/이, 카페→는/가) */
function josa(word, withBatchim, without) {
  const code = word.charCodeAt(word.length - 1);
  if (code < 0xac00 || code > 0xd7a3) return withBatchim;
  return (code - 0xac00) % 28 > 0 ? withBatchim : without;
}

/** 댓글 참여 유도 문구 (게시물마다 랜덤 회전) */
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

function buildCaption(theme, places) {
  const keyword = process.env.DM_KEYWORD || "어디야";
  const lines = places.map((p, i) => `${i + 1}. ${p.name} (${p.region}) — ${p.desc}`);
  const tags = [...(theme.tags ?? []), "맛집추천", "맛집리스트", "먹스타그램", "저장각", "맛집투어"]
    .map((t) => `#${t}`)
    .join(" ");
  return (
    `🔥 ${theme.title}\n\n` +
    `${lines.join("\n")}\n\n` +
    `💬 ${engagementLine(theme, places.length)}\n\n` +
    `📌 저장해두고 하나씩 정복해 보세요!\n` +
    `상세 주소가 궁금하시면 댓글에 "${keyword}" 남기고 팔로우해 주세요. ${places.length}곳 전부 DM으로 보내드릴게요 📩\n\n` +
    `${tags}\n\n📷 사진·정보 출처: 한국관광공사 TourAPI`
  );
}

async function main() {
  const { db, initDb } = await import("../lib/db.ts");
  const { publishCarousel } = await import("../lib/instagram.ts");
  const themesData = JSON.parse(fs.readFileSync(new URL("../data/roundup-themes.json", import.meta.url), "utf8"));
  await initDb();

  // 테마 로테이션 포인터 (DB에 저장)
  const idxRow = await db.execute("SELECT value FROM config WHERE key='roundup_idx'");
  let idx = idxRow.rows.length ? Number(idxRow.rows[0].value) : 0;

  // 후보 테마 최대 3개 시도 (수집 부족 시 다음 테마)
  let theme = null, places = [];
  for (let t = 0; t < 3; t++) {
    const cand = themesData.themes[(idx + t) % themesData.themes.length];
    const got = await collectPlaces(cand);
    console.log(`[${cand.title}] 수집: ${got.length}곳 (목표 ${cand.count})`);
    if (got.length >= Math.min(5, cand.count)) {
      theme = cand;
      places = got;
      idx = (idx + t + 1) % themesData.themes.length;
      break;
    }
  }
  if (!theme) throw new Error("수집 가능한 테마 없음");

  // 한줄평 먼저 (비전 호출이 분당 한도를 소모하기 전에)
  const descs = await makeDescriptions(theme, places);
  places.forEach((p, i) => (p.desc = descs[i]));

  // 음식 사진 우선 선택 (Gemini 비전) — 무료 등급 분당 한도 고려해 4초 간격 순차
  for (const p of places) {
    await pickFoodImage(p);
    await new Promise((r) => setTimeout(r, 4000));
  }
  console.log(`음식 사진 교체: ${places.filter((p) => p.foodPicked).length}/${places.length}곳`);

  // 표지 합성
  const cover = await composeCover(theme, places);

  if (DRY) {
    console.log("DRY 모드 — 발행 생략. 표지:", cover);
    console.log(buildCaption(theme, places));
    fs.copyFileSync(cover, "roundup-preview.jpg");
    return;
  }

  // 표지 업로드 → 캐러셀 (표지 + 사진 최대 9장 = 10장 제한)
  const coverUrl = await uploadPublic(cover);
  console.log("표지 URL:", coverUrl);
  const slides = [coverUrl, ...places.slice(0, 9).map((p) => p.imageUrl)];
  const caption = buildCaption(theme, places);
  const mediaId = await publishCarousel(slides, caption);
  console.log("✅ 모음집 발행 완료! media id:", mediaId);

  // 기록 (댓글 → DM에 전체 주소 목록 전달)
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  await db.execute({
    sql: `INSERT INTO posts (content_id, place_name, address, category, image_url, image_urls, caption, ig_media_id, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'published')`,
    args: [
      `roundup-${theme.key}-${today}`,
      theme.title,
      places.map((p, i) => `${i + 1}. ${p.name} — ${p.address}`).join("\n"),
      "모음집",
      places[0].imageUrl,
      JSON.stringify(slides),
      caption,
      mediaId,
    ],
  });
  await db.execute({
    sql: "INSERT OR REPLACE INTO config (key, value, updated_at) VALUES ('roundup_idx', ?, datetime('now'))",
    args: [String(idx)],
  });
  console.log("완료:", theme.title);
}

function curlUpload(args) {
  return new Promise((resolve, reject) => {
    const p = spawn("curl", ["-s", "--max-time", "120", ...args]);
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
      const res = await put(`roundups/${Date.now()}.jpg`, fs.readFileSync(filePath), {
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
