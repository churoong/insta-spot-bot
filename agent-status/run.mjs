import { createClient } from "@libsql/client";
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
const day = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
// 사용자 요청(2026-10-28): 오늘 남은 하루 1회 활동을 지금 바로 — 예정 시각을 00:00으로 당긴다
const keys = ["likes", "tlikes", "acom", "visited", "peer", "peerprop", "reg", "req", "where", "followup"];
for (const k of keys) {
  const done = (await db.execute({ sql: "SELECT value FROM private_log WHERE key = ?", args: [`${k}:${day}`] })).rows[0]?.value;
  await db.execute({ sql: "INSERT OR REPLACE INTO private_log (key, value, updated_at) VALUES (?, '00:00', datetime('now'))", args: [`${k}-at:${day}`] });
  console.log(`::notice title=${k}::오늘 실적 ${done ?? "없음"} → 시각 00:00`);
}
await db.execute("INSERT OR REPLACE INTO private_log (key, value, updated_at) VALUES ('pp:last', '0', datetime('now'))");
const a = (await db.execute("SELECT value FROM private_log WHERE key = 'agent:alive'")).rows[0]?.value;
console.log(`::notice title=agent:alive::${a}`);
