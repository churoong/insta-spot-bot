import { createClient } from "@libsql/client";
import { chromium } from "playwright";
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
const SITE = "https://insta-spot-bot.vercel.app";
const before = (await db.execute("SELECT COALESCE(SUM(views),0) v FROM map_visits")).rows[0].v;
const b = await chromium.launch();
const p = await b.newPage({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1" });
const reqs = [];
p.on("request", (r) => { if (r.url().includes("/api/visit")) reqs.push(r.method()); });
p.on("response", async (r) => { if (r.url().includes("/api/visit")) reqs.push(`${r.status()} ${await r.text().catch(() => "")}`); });
const errs = [];
p.on("console", (m) => { if (m.type() === "error") errs.push(m.text().slice(0, 150)); });
await p.goto(`${SITE}/m`, { waitUntil: "networkidle" });
await p.waitForTimeout(3000);
await b.close();
const after = (await db.execute("SELECT COALESCE(SUM(views),0) v FROM map_visits")).rows[0].v;
console.log(`::notice title=browser::visit reqs=${JSON.stringify(reqs)} views ${before}->${after} errors=${JSON.stringify(errs).slice(0, 400)}`);
if (Number(after) > Number(before)) {
  await db.execute("UPDATE map_visits SET views = views - 1, visitors = MAX(visitors - 1, 0) WHERE kind = 'map' AND day = (SELECT MAX(day) FROM map_visits)");
  await db.execute("DELETE FROM map_visits WHERE views <= 0 AND visitors <= 0");
}
