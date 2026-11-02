import { createClient } from "@libsql/client";
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
const day = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const rows = (await db.execute({ sql: "SELECT key, value, updated_at FROM private_log WHERE key IN ('agent:alive','agent:paused','pp:last') OR (key LIKE ? AND key NOT LIKE '%-at:%' AND key NOT LIKE 'tagcnt:%') ORDER BY updated_at DESC LIMIT 25", args: [`%:${day}`] })).rows;
console.log(`::notice title=state::${rows.map((r) => `${r.key}=${String(r.value).slice(0, 40)} @${r.updated_at}`).join(" || ")}`);
console.log(`::notice title=now::${(await db.execute("SELECT datetime('now') t")).rows[0].t}`);
