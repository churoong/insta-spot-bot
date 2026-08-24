// 행정안전부 착한가격업소 통합 CSV → data/goodprice.json
//
// 분기 갱신(다음 2026-10-30)이라 분기 1회 재실행이면 충분. 12,645곳,
// 메뉴·가격 포함 — TourAPI에 없는 가격 정보라 "국밥 7,500원" 같은
// 가성비 서사를 캡션·설명에 쓸 수 있다. 배지는 백년가게(hundred)와 동일 용법.
//
// 사용법: npx tsx scripts/build-goodprice.mjs

import fs from "node:fs";

const URL =
  "https://www.data.go.kr/cmm/cmm/fileDownload.do?atchFileId=FILE_000000003681743&fileDetailSn=1&insertDataPrcus=N";

const res = await fetch(URL, {
  headers: {
    Referer: "https://www.data.go.kr/data/3045247/fileData.do",
    "User-Agent": "Mozilla/5.0",
  },
  signal: AbortSignal.timeout(120000),
});
if (!res.ok) throw new Error(`다운로드 실패 HTTP ${res.status}`);
const buf = Buffer.from(await res.arrayBuffer());
// CP949 → UTF-8
const text = new TextDecoder("euc-kr").decode(buf);

const lines = text.split(/\r?\n/).filter((l) => l.trim());
const rows = lines.slice(1).map((l) => {
  // 따옴표 필드 처리 (주소에 쉼표가 드물게 있음)
  const cols = [];
  let cur = "", inQ = false;
  for (const ch of l) {
    if (ch === '"') inQ = !inQ;
    else if (ch === "," && !inQ) { cols.push(cur); cur = ""; }
    else cur += ch;
  }
  cols.push(cur);
  return cols;
});

const shops = rows
  .map((c) => ({
    sd: String(c[0] ?? "").trim(), // 시도
    sg: String(c[1] ?? "").trim(), // 시군(구)
    n: String(c[3] ?? "").trim(), // 업소명
    m: String(c[6] ?? "").trim(), // 대표 메뉴1
    p: String(c[7] ?? "").replace(/[^\d]/g, ""), // 가격1
  }))
  .filter((s) => s.n.length >= 2);

fs.mkdirSync("data", { recursive: true });
fs.writeFileSync(
  "data/goodprice.json",
  JSON.stringify({ builtAt: new Date().toISOString(), shops })
);
console.log(`✅ data/goodprice.json — ${shops.length}곳, ${(fs.statSync("data/goodprice.json").size / 1024 / 1024).toFixed(1)}MB`);
