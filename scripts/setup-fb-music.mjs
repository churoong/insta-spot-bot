// 인스타 라이브러리 음악(Instagram Audio API) 1회 설정 도우미.
//
// 배경: Audio API(2026-06 출시)는 Facebook Login 기반(graph.facebook.com) 전용이라
// 페이지 연동 토큰이 따로 필요하다. 이 스크립트가 토큰 교환 → 페이지·IG 계정 확인 →
// 트렌딩 음악 호출 테스트까지 하고, 시크릿에 넣을 값을 출력한다.
//
// 사용법:
//   npx tsx --env-file=.env scripts/setup-fb-music.mjs <짧은_사용자_토큰>
//
// 짧은 토큰 얻는 곳: developers.facebook.com/tools/explorer 에서 본인 앱 선택 후
// 권한 instagram_basic, instagram_content_publish, pages_show_list,
// pages_read_engagement 체크하고 Generate Access Token.
// (앱에 "Facebook 로그인" 제품이 추가되어 있어야 하고, 인스타 계정이 페이스북
// 페이지와 연결되어 있어야 한다 — 인스타 앱 > 프로필 편집 > 페이지에서 연결)

const GRAPH = "https://graph.facebook.com/v23.0";
const APP_ID = process.env.META_APP_ID;
const APP_SECRET = process.env.META_APP_SECRET;

const shortToken = process.argv[2];
if (!shortToken) {
  console.error("사용법: npx tsx --env-file=.env scripts/setup-fb-music.mjs <짧은_사용자_토큰>");
  process.exit(1);
}
if (!APP_ID || !APP_SECRET) {
  console.error("META_APP_ID / META_APP_SECRET 환경변수가 필요합니다 (.env에 추가).");
  console.error("앱 ID는 developers.facebook.com > 내 앱 > 설정 > 기본 설정에서 확인.");
  process.exit(1);
}

const j = async (url) => {
  const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
  const d = await r.json();
  if (d.error) throw new Error(JSON.stringify(d.error).slice(0, 300));
  return d;
};

// 1) 장기 사용자 토큰 교환 (60일)
const long = await j(
  `${GRAPH}/oauth/access_token?grant_type=fb_exchange_token&client_id=${APP_ID}&client_secret=${APP_SECRET}&fb_exchange_token=${encodeURIComponent(shortToken)}`
);
console.log("① 장기 사용자 토큰 발급 OK (60일)");

// 2) 페이지 목록 + 연결된 IG 비즈니스 계정. 장기 사용자 토큰으로 받은 페이지 토큰은 만료되지 않는다.
const pages = await j(
  `${GRAPH}/me/accounts?fields=id,name,access_token,instagram_business_account{id,username}&access_token=${encodeURIComponent(long.access_token)}`
);
const linked = (pages.data ?? []).filter((p) => p.instagram_business_account);
if (!linked.length) {
  console.error("② ❌ 인스타 계정이 연결된 페이스북 페이지가 없습니다.");
  console.error("   인스타 앱 > 프로필 편집 > 페이지 에서 페이스북 페이지를 연결한 뒤 다시 실행하세요.");
  console.error("   (페이지가 없으면 facebook.com/pages/create 에서 무료로 만들면 됩니다)");
  process.exit(1);
}
const page = linked[0];
const igId = page.instagram_business_account.id;
console.log(`② 페이지 연결 OK: "${page.name}" ↔ @${page.instagram_business_account.username} (IG ID ${igId})`);

// 3) 트렌딩 음악 호출 테스트 — 페이지 토큰과 장기 사용자 토큰 중 되는 쪽을 채택
let token = null,
  tokenKind = "";
for (const [kind, t] of [
  ["페이지 토큰(만료 없음)", page.access_token],
  ["장기 사용자 토큰(60일)", long.access_token],
]) {
  try {
    const audio = await j(
      `${GRAPH}/ig_audio?audio_type=music&user_id=${igId}&access_token=${encodeURIComponent(t)}`
    );
    const list = audio.data ?? [];
    console.log(`③ 트렌딩 음악 호출 OK (${kind}) — ${list.length}곡 반환`);
    for (const a of list.slice(0, 5)) {
      console.log(`   · ${a.title ?? a.name ?? a.id}${a.display_artist ? ` — ${a.display_artist}` : ""}`);
    }
    token = t;
    tokenKind = kind;
    break;
  } catch (e) {
    console.log(`   (${kind}로는 실패: ${String(e).slice(0, 140)})`);
  }
}
if (!token) {
  console.error("③ ❌ 두 토큰 모두 ig_audio 호출 실패. 앱 권한(instagram_basic, instagram_content_publish)을 확인하세요.");
  process.exit(1);
}

console.log("\n════════ GitHub Secrets에 등록할 값 ════════");
console.log(`FB_IG_USER_ID = ${igId}`);
console.log(`FB_ACCESS_TOKEN = ${token}`);
console.log(`(채택된 토큰: ${tokenKind})`);
console.log("═══════════════════════════════════════════");
console.log("등록 후 다음 발행부터 릴스에 인스타 라이브러리 음악이 자동으로 붙습니다.");
if (tokenKind.includes("60일")) {
  console.log("⚠️ 60일 토큰이 채택됐습니다 — 만료 전 이 스크립트를 다시 실행해 갱신하세요.");
}
