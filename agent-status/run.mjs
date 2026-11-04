const B = "https://insta-spot-bot.vercel.app";
const out = [];
for (const p of ["/", "/m", "/m/1", "/e/x", "/llms.txt", "/sitemap.xml", "/api/visit"]) {
  try {
    const t = Date.now();
    const r = await fetch(B + p, { redirect: "manual", signal: AbortSignal.timeout(30000) });
    const b = (await r.text()).replace(/\s+/g, " ");
    const err = b.match(/(Application error[^<]{0,120}|digest[^<]{0,80}|Error[^<]{0,160})/)?.[0] || "";
    out.push(`${p} ${r.status} ${Date.now() - t}ms len=${b.length} loc=${r.headers.get("location") || ""} x-vercel-error=${r.headers.get("x-vercel-error") || ""} ${r.status >= 400 ? b.slice(0, 200) : err.slice(0, 160)}`);
  } catch (e) { out.push(`${p} FAIL ${e.message}`); }
}
console.log(`::notice title=site::${out.join(" || ")}`);
