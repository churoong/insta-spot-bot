// Threads 공식 API(2026-10-27 사용자 결정 — 모음집을 스레드에도 동시 발행).
// 토큰은 /api/threads/connect → callback이 DB config에 저장한다(GitHub 시크릿 불필요).
// 장기 토큰은 60일 만료 — 쓸 때마다 7일 넘었으면 갱신하고, metrics 크론도 매일 갱신을 시도한다.
import { db, initDb } from "./db";

const HOST = "https://graph.threads.com"; // 문서 기준 호스트(.net도 아직 응답한다)
export const THREADS_GRAPH = `${HOST}/v1.0`;

export function threadsRedirectUri() {
  const base = (process.env.APP_BASE_URL || "https://insta-spot-bot.vercel.app").replace(/\/$/, "");
  return `${base}/api/threads/callback`;
}

async function cfgRow(key: string) {
  return (await db.execute({ sql: "SELECT value, updated_at FROM config WHERE key = ?", args: [key] })).rows[0];
}

async function setCfg(key: string, value: string) {
  await db.execute({
    sql: "INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))",
    args: [key, value],
  });
}

/** 연결 안 돼 있으면 null — 호출부는 조용히 건너뛴다 */
async function getAuth(): Promise<{ token: string; userId: string } | null> {
  await initDb();
  const tok = await cfgRow("threads_token");
  const uid = await cfgRow("threads_user_id");
  if (!tok?.value || !uid?.value) return null;
  return { token: String(tok.value), userId: String(uid.value) };
}

/** 장기 토큰 갱신 — 발급 24시간 뒤부터 가능, 7일마다만 실제로 부른다 */
export async function refreshThreadsToken(force = false): Promise<string> {
  await initDb();
  const row = await cfgRow("threads_token");
  if (!row?.value) return "미연결";
  const ageDays = (Date.now() - new Date(String(row.updated_at).replace(" ", "T") + "Z").getTime()) / 864e5;
  if (!force && ageDays < 7) return `갱신 불필요(${ageDays.toFixed(1)}일)`;
  const r = await fetch(
    `${HOST}/refresh_access_token?grant_type=th_refresh_token&access_token=${encodeURIComponent(String(row.value))}`,
    { signal: AbortSignal.timeout(15000) }
  );
  const j = await r.json();
  if (!j.access_token) throw new Error(`Threads 토큰 갱신 실패: ${JSON.stringify(j).slice(0, 200)}`);
  await setCfg("threads_token", j.access_token);
  return "갱신됨";
}

/** OAuth 콜백: code → 단기 토큰 → 장기 토큰 → 사용자 정보 저장 */
export async function connectThreads(code: string): Promise<string> {
  const appId = process.env.THREADS_APP_ID!, secret = process.env.THREADS_APP_SECRET!;
  const body = new URLSearchParams({
    client_id: appId, client_secret: secret, code: code.replace(/#_$/, ""),
    grant_type: "authorization_code", redirect_uri: threadsRedirectUri(),
  });
  const s = await (await fetch(`${HOST}/oauth/access_token`, { method: "POST", body })).json();
  if (!s.access_token) throw new Error(`코드 교환 실패: ${JSON.stringify(s).slice(0, 200)}`);
  const l = await (await fetch(
    `${HOST}/access_token?grant_type=th_exchange_token&client_secret=${encodeURIComponent(secret)}&access_token=${encodeURIComponent(s.access_token)}`
  )).json();
  if (!l.access_token) throw new Error(`장기 토큰 교환 실패: ${JSON.stringify(l).slice(0, 200)}`);
  const me = await (await fetch(`${THREADS_GRAPH}/me?fields=id,username&access_token=${encodeURIComponent(l.access_token)}`)).json();
  if (!me.id) throw new Error(`사용자 조회 실패: ${JSON.stringify(me).slice(0, 200)}`);
  await initDb();
  await setCfg("threads_token", l.access_token);
  await setCfg("threads_user_id", String(me.id));
  await setCfg("threads_username", String(me.username ?? ""));
  return String(me.username ?? me.id);
}

async function post(path: string, params: Record<string, string>, token: string) {
  const res = await fetch(`${THREADS_GRAPH}/${path}`, {
    method: "POST",
    body: new URLSearchParams({ ...params, access_token: token }),
    signal: AbortSignal.timeout(60000),
  });
  const j = await res.json();
  if (j.error) throw new Error(`Threads ${path}: ${j.error.message ?? JSON.stringify(j.error)}`);
  return j;
}

async function waitContainer(id: string, token: string, maxMs: number) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    await new Promise((r) => setTimeout(r, 10000));
    const j = await (await fetch(`${THREADS_GRAPH}/${id}?fields=status,error_message&access_token=${encodeURIComponent(token)}`)).json();
    if (j.status === "FINISHED") return;
    if (j.status === "ERROR" || j.status === "EXPIRED") throw new Error(`Threads 컨테이너 ${j.status}: ${j.error_message ?? ""}`);
  }
  throw new Error("Threads 컨테이너 처리 시간 초과");
}

/**
 * 스레드 글 발행. 영상이 있으면 영상, 실패하면 이미지로 한 번 더. 연결 전이면 null.
 * text는 500자 한도(이모지는 바이트 수로 센다) — 호출부가 짧게 만든다.
 */
export async function publishThreads(opts: { text: string; videoUrl?: string; imageUrl?: string; topicTag?: string }): Promise<string | null> {
  const auth = await getAuth();
  if (!auth) return null;
  try { await refreshThreadsToken(); } catch (e) { console.error(String(e).slice(0, 160)); }
  const { token, userId } = (await getAuth())!;
  const base: Record<string, string> = { text: opts.text };
  if (opts.topicTag) base.topic_tag = opts.topicTag;
  const tries: Record<string, string>[] = [];
  if (opts.videoUrl) tries.push({ ...base, media_type: "VIDEO", video_url: opts.videoUrl });
  if (opts.imageUrl) tries.push({ ...base, media_type: "IMAGE", image_url: opts.imageUrl });
  if (!tries.length) tries.push({ ...base, media_type: "TEXT" });
  let last: unknown;
  for (const p of tries) {
    try {
      const c = await post(`${userId}/threads`, p, token);
      await waitContainer(String(c.id), token, p.media_type === "VIDEO" ? 240000 : 60000);
      const pub = await post(`${userId}/threads_publish`, { creation_id: String(c.id) }, token);
      return String(pub.id);
    } catch (e) {
      last = e;
      console.error(`[threads] ${p.media_type} 실패, 다음:`, String(e).slice(0, 160));
    }
  }
  throw last;
}
