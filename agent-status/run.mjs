import { createClient } from "@libsql/client";
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
const rows = (await db.execute("SELECT key, value, updated_at FROM private_log WHERE key LIKE 'bigacc:%' OR key LIKE 'plink%' OR key LIKE 'profile:link%' OR key LIKE 'acom%' OR key LIKE 'tlikes%' OR key LIKE 'fastc%' OR key LIKE 'pp:last' OR key = 'agent:alive' OR key LIKE 'agent:paused' OR key LIKE 'handle%' OR key LIKE 'ppic%' ORDER BY updated_at DESC LIMIT 40")).rows;
for (const r of rows) console.log(`::notice title=${r.key}::${String(r.value).replace(/\r?\n/g, " ").slice(0, 300)} @ ${r.updated_at}`);
const keys = (await db.execute("SELECT key FROM private_log WHERE updated_at > datetime('now','-1 day') ORDER BY updated_at DESC LIMIT 120")).rows.map((r) => r.key).join(" ");
console.log(`::notice title=keys24h::${keys.slice(0, 3000)}`);
