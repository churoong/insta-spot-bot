import { createClient } from "@libsql/client";
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
const rows = (await db.execute("SELECT key, value, updated_at FROM private_log WHERE key LIKE 'agent:%' OR key LIKE 'profile:%' OR key IN ('pp:last','online_hours') OR key LIKE 'likes:%' ORDER BY updated_at DESC LIMIT 25")).rows;
const now = (await db.execute("SELECT datetime('now') AS t")).rows[0].t;
console.log(`::notice title=now::${now} UTC`);
for (const r of rows) console.log(`::notice title=${r.key}::${String(r.value).replace(/\r?\n/g, " ").slice(0, 200)} @ ${r.updated_at}`);
const ho = (await db.execute("SELECT content_id, status, created_at FROM posts ORDER BY id DESC LIMIT 6")).rows;
for (const r of ho) console.log(`::notice title=post::${r.content_id} ${r.status} ${r.created_at}`);
