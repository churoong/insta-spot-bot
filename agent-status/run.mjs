import { createClient } from "@libsql/client";
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
const q = async (s, a = []) => (await db.execute({ sql: s, args: a })).rows;
const N = (t, m) => console.log(`::notice title=${t}::${m}`);
// 1) 허락 요청
const perm = await q("SELECT key, value, updated_at FROM private_log WHERE key LIKE 'perm:%'");
const st = {}; const posted = [];
for (const r of perm) { try { const v = JSON.parse(r.value); st[v.status] = (st[v.status] || 0) + 1; if (v.status === "posted") posted.push(`@${v.username}→${v.our_code}`); } catch {} }
const asks = await q("SELECT key, value FROM private_log WHERE key LIKE 'permask:%' ORDER BY key");
N("perm", `총 ${perm.length} ${JSON.stringify(st)} | 일별요청 ${asks.map(r => r.key.slice(13) + "=" + r.value).join(" ")} | 게시 ${posted.join(", ")}`);
// 2) 팔로우·첫댓글·언팔·차단
const daily = await q("SELECT key, value FROM private_log WHERE (key LIKE 'tfollow:2026%' OR key LIKE 'fast:2026%' OR key LIKE 'unfollow:2026%' OR key LIKE 'likerfollow:2026%' OR key LIKE 'fp-follow:2026%') AND key >= ? ORDER BY key", ["fast:2026-11-07"]);
N("daily", daily.map(r => `${r.key}=${r.value}`).join(" "));
const alive = await q("SELECT key, value, updated_at FROM private_log WHERE key IN ('agent:alive','agent:paused','quota-mult') OR key LIKE 'pause%' ORDER BY updated_at DESC LIMIT 8");
N("agent", alive.map(r => `${r.key}=${String(r.value).slice(0, 120)} @${r.updated_at}`).join(" || "));
const blocks = await q("SELECT key, value, updated_at FROM private_log WHERE key LIKE '%block%' OR key LIKE '%pause%' ORDER BY updated_at DESC LIMIT 10");
N("blocks", blocks.map(r => `${r.key}=${String(r.value).slice(0, 80)} @${r.updated_at}`).join(" || "));
// 3) 팔로워
const fl = await q("SELECT date, count FROM follower_log WHERE date >= '2026-10-25' ORDER BY date");
N("fol", fl.map(r => `${String(r.date).slice(5)}=${r.count}`).join(" "));
// 4) 게시물
const rows = await q("SELECT created_at t, content_id cid, views v, saved s, like_count l, comment_count c, reel_format f FROM posts WHERE status='published' AND created_at > '2026-11-01' ORDER BY created_at");
const out = rows.map(x => `${String(x.t).slice(5, 13)}|${String(x.cid).replace(/-2026[\d-]+$/, '')}|${x.v ?? '-'}|${x.s ?? '-'}|${x.l}|${x.c}|${x.f ?? ''}`);
for (let i = 0; i < out.length; i += 25) N(`posts${i / 25}`, out.slice(i, i + 25).join(" ## "));
// 5) 전환
const conv = await q(`SELECT kind, COUNT(*) a, SUM(CASE WHEN n.key IS NOT NULL THEN 1 ELSE 0 END) c FROM (
  SELECT substr(key, 5, instr(substr(key, 5), ':') - 1) kind, substr(key, 5 + instr(substr(key, 5), ':')) uid, updated_at t
  FROM private_log WHERE key LIKE 'src:%' AND updated_at > datetime('now','-21 days')) s
  LEFT JOIN private_log n ON n.key = 'newf:' || s.uid AND n.updated_at >= s.t AND n.updated_at <= datetime(s.t, '+14 days') GROUP BY kind ORDER BY a DESC`);
N("conv", conv.map(r => `${r.kind} ${r.c}/${r.a}`).join(" · "));
N("now", (await q("SELECT datetime('now') t"))[0].t);
