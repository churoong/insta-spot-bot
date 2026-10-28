import { createClient } from "@libsql/client";
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
const rows = (await db.execute("SELECT * FROM posts WHERE created_at > datetime('now','-14 hours') ORDER BY id DESC LIMIT 4")).rows;
for (const r of rows) {
  const cap = String(r.caption ?? "");
  console.log(`::notice title=post ${r.content_id}::status=${r.status} ig=${r.ig_media_id} threads=${r.threads_id ?? "-"} fmt=${r.reel_format ?? "-"} at=${r.created_at} | ${cap.split("\n").slice(0, 10).join(" / ").slice(0, 600)}`);
}
const cols = (await db.execute("PRAGMA table_info(posts)")).rows.map((c) => c.name).join(",");
console.log(`::notice title=cols::${cols}`);
