import { db, initDb } from "@/lib/db";
import PostActions from "./components/PostActions";
import themesData from "@/data/roundup-themes.json";

export const dynamic = "force-dynamic";

// ===== 수동 참여 가이드: 매일 바뀌는 추천 해시태그·시간대 =====
// 자동 좋아요/팔로우는 API 미지원+계정 정지 위험이라, 사람이 직접 하는 참여를 돕는다.

const SIDO_TAG: Record<string, string> = {
  서울특별시: "서울", 부산광역시: "부산", 대구광역시: "대구", 인천광역시: "인천",
  광주광역시: "광주", 대전광역시: "대전", 울산광역시: "울산",
  경기도: "경기", 강원특별자치도: "강원", 강원도: "강원",
  충청북도: "충북", 충청남도: "충남", 전북특별자치도: "전북", 전라남도: "전남",
  경상북도: "경북", 경상남도: "경남", 제주특별자치도: "제주",
};
const EVERGREEN = ["맛집추천", "먹스타그램", "국내여행", "숨은맛집", "맛집투어", "여행스타그램", "로컬맛집", "주말나들이"];

function buildEngagementGuide(posts: any[]) {
  // 날짜 시드 (KST 기준, 매일 로테이션)
  const day = Math.floor((Date.now() + 9 * 3600 * 1000) / 86400000);
  const themes: any[] = (themesData as any).themes;

  // ① 테마 태그 2개 (로테이션) + ② 최근 게시물 지역 태그 + ③ 상시 태그
  const t1 = themes[day % themes.length];
  const t2 = themes[(day + 7) % themes.length];
  const regionTags = [
    ...new Set(
      posts
        .filter((p) => p.status === "published" && p.address)
        .slice(0, 8)
        .map((p) => SIDO_TAG[String(p.address).split(/\s+/)[0]])
        .filter(Boolean)
        .map((r) => `${r}맛집`)
    ),
  ].slice(0, 2);
  const tags = [
    ...new Set([
      ...(t1.tags ?? []).slice(0, 2),
      ...(t2.tags ?? []).slice(0, 1),
      ...regionTags,
      EVERGREEN[day % EVERGREEN.length],
      EVERGREEN[(day + 3) % EVERGREEN.length],
    ]),
  ].slice(0, 7);

  // 반응 데이터 기반 추천 시간대 (충분한 데이터 없으면 기본 골든타임)
  const hourScore: Record<number, number> = {};
  for (const p of posts) {
    if (p.status !== "published") continue;
    const score = (Number(p.like_count) || 0) + (Number(p.comment_count) || 0) * 3;
    if (score <= 0) continue;
    const kstHour = (new Date(String(p.created_at).replace(" ", "T") + "Z").getUTCHours() + 9) % 24;
    hourScore[kstHour] = (hourScore[kstHour] ?? 0) + score;
  }
  const topHours = Object.entries(hourScore)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([h]) => `${h}시`);
  const timeSlots =
    topHours.length >= 2
      ? `${topHours.join(", ")} 전후 (우리 게시물 반응 데이터 기준) · 기본 골든타임 12~13시, 19~22시`
      : "점심 12~13시, 저녁 19~22시 (인스타 골든타임)";

  return { tags, timeSlots };
}

async function loadData() {
  try {
    await initDb();
    const posts = await db.execute(
      "SELECT id, place_name, address, category, image_url, image_urls, caption, status, created_at, like_count, comment_count FROM posts ORDER BY datetime(created_at) DESC, id DESC LIMIT 50"
    );
    const dms = await db.execute(
      "SELECT COUNT(*) AS n FROM dm_log"
    );
    const popular = await db.execute(
      `SELECT place_name, like_count, comment_count,
              (COALESCE(like_count,0) + COALESCE(comment_count,0) * 3) AS score
       FROM posts WHERE status='published' AND category != '주간베스트'
       ORDER BY score DESC, id DESC LIMIT 3`
    );
    const live = process.env.IG_ACCESS_TOKEN ? true : false;

    // 발행 상태(쿨다운) + 최근 크론 로그
    let cooldownMin = 0;
    try {
      const cd = await db.execute("SELECT value FROM config WHERE key='publish_cooldown_until'");
      if (cd.rows.length) {
        const until = new Date(String(cd.rows[0].value).replace(" ", "T") + "Z").getTime();
        cooldownMin = Math.max(0, Math.round((until - Date.now()) / 60000));
      }
    } catch { /* config 없음 */ }
    let cronLog: any[] = [];
    try {
      cronLog = (
        await db.execute("SELECT note, created_at FROM cron_log ORDER BY id DESC LIMIT 5")
      ).rows;
    } catch { /* 테이블 없음 */ }

    // 주간 리포트: 팔로워 추이 + 최근 7일 vs 이전 7일 성과
    let report: any = null;
    try {
      const fl = (await db.execute("SELECT date, count FROM follower_log ORDER BY date DESC LIMIT 14")).rows as any[];
      const cur = (
        await db.execute(
          `SELECT COUNT(*) n, COALESCE(SUM(like_count),0) l, COALESCE(SUM(comment_count),0) c
           FROM posts WHERE status='published' AND created_at >= datetime('now','-7 days')`
        )
      ).rows[0] as any;
      const prev = (
        await db.execute(
          `SELECT COUNT(*) n, COALESCE(SUM(like_count),0) l, COALESCE(SUM(comment_count),0) c
           FROM posts WHERE status='published'
             AND created_at >= datetime('now','-14 days') AND created_at < datetime('now','-7 days')`
        )
      ).rows[0] as any;
      const best = (
        await db.execute(
          `SELECT place_name, like_count, comment_count FROM posts
           WHERE status='published' AND created_at >= datetime('now','-7 days')
           ORDER BY (COALESCE(like_count,0)+COALESCE(comment_count,0)*3) DESC LIMIT 1`
        )
      ).rows[0] as any;
      const now = fl[0] ? Number(fl[0].count) : null;
      const weekAgo = fl.find((r) => r.date <= new Date(Date.now() + 9 * 3600 * 1000 - 7 * 86400 * 1000).toISOString().slice(0, 10));
      report = {
        followers: now,
        followersDelta: now !== null && weekAgo ? now - Number(weekAgo.count) : null,
        posts7: Number(cur.n), likes7: Number(cur.l), comments7: Number(cur.c),
        postsPrev: Number(prev.n), likesPrev: Number(prev.l), commentsPrev: Number(prev.c),
        best: best ?? null,
      };
    } catch { /* 데이터 부족 */ }

    // 팔로워 추천 댓글 모음 (모음집 후보 발굴용)
    let suggestions: any[] = [];
    try {
      suggestions = (
        await db.execute(
          "SELECT username, text, created_at FROM comment_suggestions ORDER BY id DESC LIMIT 8"
        )
      ).rows;
    } catch { /* 테이블 없음 */ }

    return {
      posts: posts.rows,
      dmCount: Number(dms.rows[0].n),
      popular: popular.rows.filter((r: any) => Number(r.score) > 0),
      cooldownMin,
      cronLog,
      report,
      suggestions,
      live,
    };
  } catch (e) {
    return { error: String(e) };
  }
}

export default async function Home() {
  const data = await loadData();

  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "40px 20px" }}>
      <h1 style={{ fontSize: 24 }}>📍 Insta Spot Bot</h1>
      <p style={{ color: "#9aa0ae" }}>
        한국관광공사 TourAPI 기반 맛집·여행지 인스타그램 자동 포스팅 봇
      </p>

      {"error" in data ? (
        <div
          style={{
            background: "#1a1d24",
            border: "1px solid #2a2e38",
            borderRadius: 12,
            padding: 24,
            marginTop: 24,
          }}
        >
          <h2 style={{ fontSize: 16, marginTop: 0 }}>⚙️ DB 연결 오류</h2>
          <p style={{ color: "#e08080", lineHeight: 1.7 }}>{data.error}</p>
          <p style={{ color: "#9aa0ae", lineHeight: 1.7 }}>
            로컬은 자동으로 <code>local.db</code> 파일을 씁니다. 배포 시에는{" "}
            <code>TURSO_DATABASE_URL</code>/<code>TURSO_AUTH_TOKEN</code>을
            환경변수로 넣어주세요. 자세한 절차는 <code>DEPLOY.md</code>를 참고하세요.
          </p>
        </div>
      ) : (
        <>
          {!data.live && (
            <div
              style={{
                background: "#3a2f14",
                border: "1px solid #5c4a1a",
                borderRadius: 12,
                padding: "12px 16px",
                marginTop: 20,
                color: "#f0d894",
                fontSize: 13.5,
                lineHeight: 1.6,
              }}
            >
              🟡 <b>반자동 모드</b> — Meta 연결 전까지는 봇이 사진·캡션을 준비해
              드립니다. 각 게시물의 <b>캡션 복사</b> + <b>이미지 저장</b> 버튼으로
              인스타에 직접 올려보세요. Meta 토큰을 넣으면 자동 업로드로 전환됩니다.
              <div style={{ marginTop: 8, color: "#c9b98a", fontSize: 12.5 }}>
                📱 올리는 법: ① <b>사진 저장</b> 버튼 누르기(또는 사진 하나씩 탭해서
                저장) → ② 인스타 앱에서 새 게시물에 여러 장 선택 → ③ <b>캡션 복사</b>{" "}
                눌러 설명란에 붙여넣기 → 업로드!
              </div>
            </div>
          )}
          <div style={{ display: "flex", gap: 12, margin: "20px 0" }}>
            <Stat label={data.live ? "발행된 게시글" : "생성된 미리보기"} value={data.posts.length} />
            <Stat label="발송된 DM" value={data.dmCount} />
          </div>

          {(data as any).cooldownMin > 0 && (
            <div
              style={{
                background: "#3a1e1e",
                border: "1px solid #5c2a2a",
                borderRadius: 12,
                padding: "12px 16px",
                marginBottom: 16,
                color: "#f0b4b4",
                fontSize: 13.5,
                lineHeight: 1.6,
              }}
            >
              ⛔ <b>발행 일시중단</b> — 인스타그램이 이 계정의 게시 활동을 일시
              제한했습니다(행동 차단). 재시도가 차단을 연장시키지 않도록 봇이 발행을
              쉬는 중이에요. 약 {(data as any).cooldownMin >= 60 ? `${Math.round((data as any).cooldownMin / 60)}시간` : `${(data as any).cooldownMin}분`} 후 자동 재시도합니다. (읽기·DM·댓글은 정상)
            </div>
          )}

          {(() => {
            const guide = buildEngagementGuide(data.posts as any[]);
            return (
              <div
                style={{
                  background: "#1a1d24",
                  border: "1px solid #2a2e38",
                  borderRadius: 12,
                  padding: "14px 16px",
                  marginBottom: 16,
                }}
              >
                <div style={{ fontWeight: 700, marginBottom: 4 }}>📱 오늘의 참여 가이드 (10분)</div>
                <div style={{ color: "#9aa0ae", fontSize: 12.5, marginBottom: 10 }}>
                  자동 좋아요·팔로우는 계정 정지 위험이라, 매일 이 루틴만 직접 해주세요. 태그를 누르면
                  인스타그램에서 바로 열려요.
                </div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
                  {guide.tags.map((t) => (
                    <a
                      key={t}
                      href={`https://www.instagram.com/explore/tags/${encodeURIComponent(t)}/`}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{
                        fontSize: 13,
                        fontWeight: 600,
                        color: "#8ab4f8",
                        background: "#12151b",
                        border: "1px solid #2a3d5c",
                        borderRadius: 15,
                        padding: "4px 11px",
                        textDecoration: "none",
                      }}
                    >
                      #{t}
                    </a>
                  ))}
                </div>
                <div style={{ color: "#c8cdd8", fontSize: 13, lineHeight: 1.8 }}>
                  ① 위 태그의 최신글 15개에 좋아요 ❤️<br />
                  ② 마음에 드는 게시물 2~3곳에 진심 댓글 💬<br />
                  ③ 결이 맞는 활발한 계정 2~3개 팔로우 🤝<br />
                  ④ 우리 게시물의 새 댓글에 하트·답글 달기 🙌
                </div>
                <div style={{ color: "#c9b98a", fontSize: 12.5, marginTop: 8 }}>
                  ⏰ 추천 시간대: {guide.timeSlots}
                </div>
              </div>
            );
          })()}

          {data.popular && data.popular.length > 0 && (
            <div
              style={{
                background: "#1a1d24",
                border: "1px solid #2a2e38",
                borderRadius: 12,
                padding: "14px 16px",
                marginBottom: 16,
              }}
            >
              <div style={{ fontWeight: 700, marginBottom: 8 }}>🔥 인기 TOP{data.popular.length}</div>
              {data.popular.map((p: any, i: number) => (
                <div key={i} style={{ color: "#c8cdd8", fontSize: 13.5, padding: "3px 0" }}>
                  {["🥇", "🥈", "🥉"][i]} {p.place_name}
                  <span style={{ color: "#9aa0ae", marginLeft: 8 }}>
                    ❤️ {Number(p.like_count) || 0} 💬 {Number(p.comment_count) || 0}
                  </span>
                </div>
              ))}
            </div>
          )}
          {(data as any).report && (
            <div
              style={{
                background: "#1a1d24",
                border: "1px solid #2a2e38",
                borderRadius: 12,
                padding: "14px 16px",
                marginBottom: 16,
              }}
            >
              <div style={{ fontWeight: 700, marginBottom: 8 }}>📊 주간 리포트 (최근 7일)</div>
              {(() => {
                const r = (data as any).report;
                const delta = (cur: number, prev: number) =>
                  prev > 0 || cur > 0 ? (
                    <span style={{ color: cur >= prev ? "#7ee0a8" : "#e08080", fontSize: 12 }}>
                      {" "}({cur >= prev ? "▲" : "▼"}{Math.abs(cur - prev)})
                    </span>
                  ) : null;
                return (
                  <div style={{ color: "#c8cdd8", fontSize: 13.5, lineHeight: 1.9 }}>
                    👥 팔로워:{" "}
                    {r.followers !== null ? (
                      <>
                        <b>{r.followers}</b>
                        {r.followersDelta !== null && (
                          <span style={{ color: r.followersDelta >= 0 ? "#7ee0a8" : "#e08080", fontSize: 12 }}>
                            {" "}(주간 {r.followersDelta >= 0 ? "+" : ""}{r.followersDelta})
                          </span>
                        )}
                      </>
                    ) : (
                      <span style={{ color: "#9aa0ae" }}>수집 중 (다음 크론부터 기록)</span>
                    )}
                    <br />
                    📤 발행 {r.posts7}건{delta(r.posts7, r.postsPrev)} · ❤️ {r.likes7}
                    {delta(r.likes7, r.likesPrev)} · 💬 {r.comments7}
                    {delta(r.comments7, r.commentsPrev)}
                    {r.best && (
                      <>
                        <br />
                        🏆 이번 주 베스트: {r.best.place_name} (❤️ {Number(r.best.like_count) || 0} 💬{" "}
                        {Number(r.best.comment_count) || 0})
                      </>
                    )}
                  </div>
                );
              })()}
            </div>
          )}

          {(data as any).suggestions && (data as any).suggestions.length > 0 && (
            <div
              style={{
                background: "#1a1d24",
                border: "1px solid #2a2e38",
                borderRadius: 12,
                padding: "14px 16px",
                marginBottom: 16,
              }}
            >
              <div style={{ fontWeight: 700, marginBottom: 4 }}>💬 팔로워 추천 모음</div>
              <div style={{ color: "#9aa0ae", fontSize: 12.5, marginBottom: 8 }}>
                댓글로 들어온 추천·의견이에요. 괜찮은 가게는 다음 모음집 후보로!
              </div>
              {(data as any).suggestions.map((s: any, i: number) => (
                <div key={i} style={{ borderTop: "1px solid #23262e", padding: "6px 0", fontSize: 13 }}>
                  <span style={{ color: "#8ab4f8" }}>@{s.username || "익명"}</span>{" "}
                  <span style={{ color: "#c8cdd8" }}>{String(s.text).slice(0, 80)}</span>{" "}
                  <span style={{ color: "#6f7580", fontSize: 11.5 }}>{toKst(s.created_at)}</span>
                </div>
              ))}
            </div>
          )}

          {data.posts.length === 0 && (
            <p style={{ color: "#9aa0ae" }}>
              아직 게시물이 없습니다. 크론이 첫 실행되면 여기에 표시됩니다.
            </p>
          )}
          {data.posts.map((p: any) => {
            const imgs: string[] = parseImages(p.image_urls, p.image_url);
            return (
              <div
                key={p.id}
                style={{
                  background: "#1a1d24",
                  border: "1px solid #2a2e38",
                  borderRadius: 12,
                  padding: 14,
                  marginBottom: 10,
                }}
              >
                <div style={{ fontWeight: 600, display: "flex", gap: 8, alignItems: "center" }}>
                  {p.category === "맛집" ? "🍜" : "🏞️"} {p.place_name}
                  {imgs.length > 1 && (
                    <span style={{ fontSize: 12, color: "#9aa0ae" }}>🖼️ {imgs.length}장</span>
                  )}
                  {p.status === "dry_run" && (
                    <span
                      style={{
                        fontSize: 11,
                        fontWeight: 600,
                        color: "#f0b429",
                        background: "#3a2f14",
                        border: "1px solid #5c4a1a",
                        borderRadius: 6,
                        padding: "1px 6px",
                      }}
                    >
                      미리보기
                    </span>
                  )}
                </div>
                <div style={{ color: "#9aa0ae", fontSize: 13, margin: "4px 0 10px" }}>
                  {p.address} · {toKst(p.created_at)}
                  {p.status === "published" && (
                    <span style={{ marginLeft: 8 }}>
                      ❤️ {Number(p.like_count) || 0} 💬 {Number(p.comment_count) || 0}
                    </span>
                  )}
                </div>

                {/* 이미지 캐러셀 미리보기 (가로 스크롤) */}
                {imgs.length > 0 && (
                  <div
                    style={{
                      display: "flex",
                      gap: 8,
                      overflowX: "auto",
                      paddingBottom: 6,
                      marginBottom: 10,
                    }}
                  >
                    {imgs.map((src, i) => (
                      // 썸네일을 탭하면 우리 서버 프록시로 개별 저장 (모바일 대응)
                      <a
                        key={i}
                        href={`/api/image?url=${encodeURIComponent(src)}&name=photo-${i + 1}`}
                        download={`photo-${i + 1}.jpg`}
                        title="탭하면 저장돼요"
                        style={{ flexShrink: 0, lineHeight: 0 }}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={src}
                          alt=""
                          width={110}
                          height={110}
                          style={{
                            borderRadius: 8,
                            objectFit: "cover",
                            border: "1px solid #2a2e38",
                          }}
                        />
                      </a>
                    ))}
                  </div>
                )}

                {p.caption && (
                  <div
                    style={{
                      color: "#c8cdd8",
                      fontSize: 12.5,
                      lineHeight: 1.6,
                      whiteSpace: "pre-wrap",
                      background: "#12151b",
                      borderRadius: 8,
                      padding: "8px 10px",
                    }}
                  >
                    {p.caption}
                  </div>
                )}
                {p.status === "dry_run" && p.caption && (
                  <PostActions caption={p.caption} imageUrls={imgs} />
                )}
              </div>
            );
          })}

          {(data as any).cronLog && (data as any).cronLog.length > 0 && (
            <details style={{ marginTop: 20, color: "#9aa0ae", fontSize: 12.5 }}>
              <summary style={{ cursor: "pointer" }}>🛠 최근 발행 크론 기록 (진단용)</summary>
              <div style={{ marginTop: 8, lineHeight: 1.7 }}>
                {(data as any).cronLog.map((c: any, i: number) => (
                  <div key={i} style={{ borderTop: "1px solid #23262e", padding: "5px 0" }}>
                    <span style={{ color: "#6f7580" }}>{toKst(c.created_at)}</span>{" "}
                    <span style={{ color: /실패|blocked|차단/.test(String(c.note)) ? "#e08080" : "#9aa0ae" }}>
                      {String(c.note).slice(0, 160)}
                    </span>
                  </div>
                ))}
              </div>
            </details>
          )}
        </>
      )}
    </main>
  );
}

/** DB의 UTC 시각을 한국시간(KST) 표시로 변환 */
function toKst(utc: string | null): string {
  if (!utc) return "";
  const d = new Date(String(utc).replace(" ", "T") + "Z");
  if (isNaN(d.getTime())) return String(utc);
  const k = new Date(d.getTime() + 9 * 3600 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${k.getUTCMonth() + 1}/${k.getUTCDate()} ${pad(k.getUTCHours())}:${pad(k.getUTCMinutes())} KST`;
}

/** image_urls JSON을 배열로 파싱 (없으면 단일 image_url로 폴백) */
function parseImages(imageUrls: string | null, imageUrl: string | null): string[] {
  if (imageUrls) {
    try {
      const arr = JSON.parse(imageUrls);
      if (Array.isArray(arr) && arr.length) return arr.filter(Boolean);
    } catch {
      /* 파싱 실패 시 폴백 */
    }
  }
  return imageUrl ? [imageUrl] : [];
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div
      style={{
        flex: 1,
        background: "#1a1d24",
        border: "1px solid #2a2e38",
        borderRadius: 12,
        padding: "16px 20px",
      }}
    >
      <div style={{ fontSize: 28, fontWeight: 700 }}>{value}</div>
      <div style={{ color: "#9aa0ae", fontSize: 13 }}>{label}</div>
    </div>
  );
}
