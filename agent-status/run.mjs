import { createClient } from "@libsql/client";
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
const SITE = "https://insta-spot-bot.vercel.app";
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 350.0.0";
const r = await fetch(`${SITE}/api/visit`, { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": UA, Origin: SITE }, body: '{"kind":"edition","first":false}' });
console.log(`::notice title=api::${r.status} ${(await r.text()).slice(0, 300)}`);
const rows = (await db.execute("SELECT * FROM map_visits ORDER BY day DESC LIMIT 10")).rows;
console.log(`::notice title=db::${JSON.stringify(rows)}`);
// 시험 기록은 되돌린다
await db.execute("UPDATE map_visits SET views = views - 1 WHERE kind = 'edition' AND day = (SELECT MAX(day) FROM map_visits WHERE kind = 'edition')");
await db.execute("DELETE FROM map_visits WHERE views <= 0 AND visitors <= 0");
