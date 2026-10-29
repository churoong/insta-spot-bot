import { createClient } from "@libsql/client";
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
const SITE = "https://insta-spot-bot.vercel.app";
try {
  const rows = (await db.execute("SELECT * FROM map_visits ORDER BY day DESC LIMIT 10")).rows;
  console.log(`::notice title=db::${JSON.stringify(rows)}`);
} catch (e) { console.log(`::notice title=db::ERR ${String(e).slice(0, 200)}`); }
const html = await (await fetch(`${SITE}/m`)).text();
const chunks = [...html.matchAll(/\/_next\/static\/chunks\/[^"]+\.js/g)].map((m) => m[0]);
let found = false;
for (const c of chunks) { const js = await (await fetch(SITE + c)).text(); if (js.includes("/api/visit")) { found = c; break; } }
console.log(`::notice title=page::status ok, chunks ${chunks.length}, beacon in ${found}`);
const r = await fetch(`${SITE}/api/visit`, { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": "probe-bot" }, body: '{"kind":"map"}' });
console.log(`::notice title=api::${r.status} ${(await r.text()).slice(0, 200)}`);
const admin = await (await fetch(`${SITE}/`)).text();
console.log(`::notice title=admin::has card=${admin.includes("맛디 지도 접속")}`);
