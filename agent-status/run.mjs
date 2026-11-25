const N = (t, m) => console.log(`::notice title=${t}::${m}`);
const px = process.env.PEXELS_KEY, pb = process.env.PIXABAY_KEY;
N("keys", `PEXELS_KEY ${px ? "있음(" + px.length + "자)" : "없음"} · PIXABAY_KEY ${pb ? "있음(" + pb.length + "자)" : "없음"}`);
const out = [];
for (const q of ["korean soup", "cold noodles", "korean bbq", "latte coffee", "korean food"]) {
  let a = "-", b = "-";
  if (px) try { const r = await fetch(`https://api.pexels.com/videos/search?query=${encodeURIComponent(q)}&orientation=portrait&per_page=20`, { headers: { Authorization: px } }); const j = await r.json(); a = r.ok ? `${j.total_results ?? (j.videos || []).length}편` : `HTTP ${r.status}`; } catch (e) { a = "오류"; }
  if (pb) try { const r = await fetch(`https://pixabay.com/api/videos/?key=${pb}&q=${encodeURIComponent(q)}&per_page=20`); const j = await r.json(); a; b = r.ok ? `${j.totalHits}편` : `HTTP ${r.status}`; } catch (e) { b = "오류"; }
  out.push(`${q}: Pexels ${a} / Pixabay ${b}`);
}
N("search", out.join(" · "));
