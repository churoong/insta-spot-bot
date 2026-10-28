import { createClient } from "@libsql/client";
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
const day = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
// 새 기능(맛집 글)을 오늘 바로 — 예정 시각이 17:40 이후로 잡히면 오늘은 못 돈다
await db.execute({ sql: "INSERT OR REPLACE INTO private_log (key, value, updated_at) VALUES (?, '00:00', datetime('now'))", args: [`foodpost-at:${day}`] });
const q = async (sql, args = []) => (await db.execute({ sql, args })).rows.map((r) => `${r.key}=${String(r.value).replace(/\r?\n/g, " ").slice(0, 100)} @${r.updated_at}`).join(" || ");
console.log(`::notice title=state::${await q("SELECT * FROM private_log WHERE key IN ('agent:alive','agent:paused','pp:last')")}`);
console.log(`::notice title=today::${await q("SELECT * FROM private_log WHERE key IN (?,?,?,?,?,?,?,?)", ["acom", "tlikes", "visited-like", "visited-cmt", "fp-like", "fp-cmt", "fp-follow", "tlikes-retry"].map((k) => `${k}:${day}`))}`);
