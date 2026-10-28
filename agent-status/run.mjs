import { createClient } from "@libsql/client";
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
const day = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const q = async (sql, args = []) => (await db.execute({ sql, args })).rows.map((r) => `${r.key}=${String(r.value).replace(/\r?\n/g, " ").slice(0, 100)} @${r.updated_at}`).join(" || ");
console.log(`::notice title=state::${await q("SELECT * FROM private_log WHERE key IN ('agent:alive','agent:paused','pp:last')")}`);
const ks = ["acom", "acom-retry", "tlikes", "tlikes-retry", "visited-like", "visited-cmt", "fp-like", "fp-cmt", "fp-follow", "likes", "peer-like", "fb", "likerfollow", "welcome", "welcomelike", "story-view", "story-react", "req", "where", "reg-like", "reg-cmt", "fast"];
console.log(`::notice title=today::${await q(`SELECT * FROM private_log WHERE key IN (${ks.map(() => "?").join(",")})`, ks.map((k) => `${k}:${day}`))}`);
