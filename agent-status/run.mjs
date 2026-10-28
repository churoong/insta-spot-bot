import { createClient } from "@libsql/client";
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
const q = async (sql) => (await db.execute(sql)).rows.map((r) => `${r.key}=${String(r.value).replace(/\r?\n/g, " ").slice(0, 160)} @${r.updated_at}`).join(" || ");
console.log(`::notice title=big::${await q("SELECT * FROM private_log WHERE key LIKE 'bigacc:%' OR key LIKE 'tlikes%' OR key LIKE 'fast%'")}`);
console.log(`::notice title=link::${await q("SELECT * FROM private_log WHERE key LIKE 'plink%' OR key LIKE 'profile:link%' OR key LIKE 'ppic%' OR key LIKE 'handle%' OR key LIKE 'rename%'")}`);
console.log(`::notice title=acom::${await q("SELECT * FROM private_log WHERE key LIKE 'acom:%' OR key LIKE 'acom-at%'")}`);
console.log(`::notice title=alive::${await q("SELECT * FROM private_log WHERE key IN ('agent:alive','agent:paused','pp:last')")}`);
const keys = (await db.execute("SELECT key FROM private_log WHERE updated_at > datetime('now','-1 day') AND updated_at < datetime('now','+1 hour') ORDER BY updated_at DESC LIMIT 150")).rows.map((r) => r.key).join(" ");
console.log(`::notice title=keys24h::${keys.slice(0, 3500)}`);
