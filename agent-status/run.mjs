import { createClient } from "@libsql/client";
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
const q = async (s) => (await db.execute(s)).rows;
const rows = await q(`SELECT id, content_id cid, created_at t, views v, reach r, saved s, like_count l, comment_count c, reel_format f, cover_style cs, substr(replace(caption, char(10), ' / '), 1, 70) cap
  FROM posts WHERE status='published' AND created_at > datetime('now','-75 days') ORDER BY created_at`);
const out = rows.map((x) => `${String(x.t).slice(5, 13)}|${x.cid}|${x.v ?? "-"}|${x.r ?? "-"}|${x.s ?? "-"}|${x.l}|${x.c}|${x.f ?? ""}|${x.cap}`);
const chunk = 45;
for (let i = 0; i < out.length && i / chunk < 7; i += chunk) console.log(`::notice title=p${i / chunk}::${out.slice(i, i + chunk).join(" ## ")}`);
const fl = await q("SELECT date, count FROM follower_log ORDER BY date DESC LIMIT 60");
console.log(`::notice title=fol::${fl.map((r) => `${String(r.date).slice(5)}=${r.count}`).join(" ")}`);
try { const th = await q("SELECT kind, tag, substr(posted_at,6,11) t, views, likes, replies FROM threads_posts ORDER BY posted_at DESC LIMIT 40");
  console.log(`::notice title=thr::${th.map((r) => `${r.t}|${r.kind}|${r.tag ?? ""}|${r.views ?? "-"}|${r.likes ?? "-"}|${r.replies ?? "-"}`).join(" ## ")}`); } catch (e) { console.log(`::notice title=thr::${e.message}`); }
try { const v = await q("SELECT day, SUM(views) v, SUM(visitors) u FROM map_visits GROUP BY day ORDER BY day DESC LIMIT 14");
  console.log(`::notice title=visits::${v.map((r) => `${String(r.day).slice(5)} ${r.u}/${r.v}`).join(" · ")}`); } catch (e) { console.log(`::notice title=visits::${e.message}`); }
console.log(`::notice title=n::${rows.length} rows, now ${(await q("SELECT datetime('now') t"))[0].t}`);
