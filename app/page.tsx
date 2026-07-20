import { db, initDb } from "@/lib/db";
import PostActions from "./components/PostActions";

export const dynamic = "force-dynamic";

async function loadData() {
  try {
    await initDb();
    const posts = await db.execute(
      "SELECT id, place_name, address, category, image_url, image_urls, caption, status, created_at, like_count, comment_count FROM posts ORDER BY id DESC LIMIT 50"
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
    return {
      posts: posts.rows,
      dmCount: Number(dms.rows[0].n),
      popular: popular.rows.filter((r: any) => Number(r.score) > 0),
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
