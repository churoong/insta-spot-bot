import { createClient } from "@libsql/client";
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
const rows = (await db.execute("SELECT key, value, updated_at FROM config WHERE key IN ('threads_q_day','threads_q_used')")).rows;
for (const r of rows) console.log(`::notice title=${r.key}::${String(r.value).slice(0, 500)} @${r.updated_at}`);
