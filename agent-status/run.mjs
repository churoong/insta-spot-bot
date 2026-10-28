import { createClient } from "@libsql/client";
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
const day = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
// 재시작 때문에 중간에 끊긴 타깃 좋아요 재시도 — 표시를 지워 새 코드로 다시 돌게
await db.execute({ sql: "DELETE FROM private_log WHERE key IN (?, ?)", args: [`tlikes:${day}`, `tlikes-retry:${day}`] });
console.log(`::notice title=reset::tlikes ${day}`);
