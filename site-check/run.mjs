import fs from "node:fs";
import { chromium } from "playwright";
const SITE = "https://insta-spot-bot.vercel.app";
const out = "site-check/out";
fs.mkdirSync(out, { recursive: true });
const report = [];
for (const p of ["/m", "/sitemap.xml", "/rss.xml", "/llms.txt", "/robots.txt", "/mascot.png", "/border/index.json", "/border/gukbap.json", "/geo/sigungu.json", "/46d28bdf53d2b74b8bde474bf3c121ab.txt"]) {
  try {
    const r = await fetch(SITE + p);
    const body = await r.text();
    report.push(`${p} ${r.status} ${body.length}B`);
    if (/\.(xml|txt)$/.test(p)) fs.writeFileSync(`${out}/${p.slice(1).replace(/\//g, "_")}`, body.slice(0, 4000));
  } catch (e) { report.push(`${p} ERR ${e}`); }
}
const sm = await (await fetch(SITE + "/sitemap.xml")).text();
const firstPin = sm.match(/\/m\/(\d+)</)?.[1];
const firstEd = sm.match(/\/e\/([^<]+)</)?.[1];
report.push(`sitemap urls: ${(sm.match(/<url>/g) || []).length}, first pin ${firstPin}, first ed ${firstEd}`);
const b = await chromium.launch();
const pg = await b.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const errs = [];
pg.on("console", (m) => m.type() === "error" && errs.push(m.text()));
await pg.goto(SITE + "/m", { waitUntil: "networkidle" });
await pg.waitForTimeout(3000);
await pg.screenshot({ path: `${out}/m.png` });
const btn = pg.getByText("국밥 국경선");
if (await btn.count()) { await btn.first().click(); await pg.waitForTimeout(3000); }
await pg.screenshot({ path: `${out}/m-border.png` });
await pg.screenshot({ path: `${out}/m-full.png`, fullPage: true });
if (firstPin) { await pg.goto(`${SITE}/m/${firstPin}`, { waitUntil: "networkidle" }); await pg.screenshot({ path: `${out}/pin.png` }); report.push("pin title: " + (await pg.title())); report.push("pin jsonld: " + ((await pg.locator('script[type="application/ld+json"]').first().textContent().catch(() => "")) || "").slice(0, 300)); }
if (firstEd) { await pg.goto(`${SITE}/e/${firstEd}`, { waitUntil: "networkidle" }); await pg.screenshot({ path: `${out}/edition.png` }); report.push("ed title: " + (await pg.title())); }
await b.close();
report.push("console errors: " + JSON.stringify(errs.slice(0, 8)));
fs.writeFileSync(`${out}/report.txt`, report.join("\n"));
console.log(report.join("\n"));
