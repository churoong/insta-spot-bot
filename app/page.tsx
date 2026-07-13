import { db, initDb } from "@/lib/db";
import PostActions from "./components/PostActions";

export const dynamic = "force-dynamic";

async function loadData() {
  try {
    await initDb();
    const posts = await db.execute(
      "SELECT id, place_name, address, category, image_url, caption, status, created_at FROM posts ORDER BY id DESC LIMIT 50"
    );
    const dms = await db.execute(
      "SELECT COUNT(*) AS n FROM dm_log"
    );
    const live = process.env.IG_ACCESS_TOKEN ? true : false;
    return { posts: posts.rows, dmCount: Number(dms.rows[0].n), live };
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
                📱 올리는 법: ① 이미지 열기 → 길게 눌러 저장 → ② 인스타 앱에서 새
                게시물 → ③ <b>캡션 복사</b> 눌러 설명란에 붙여넣기 → 업로드!
              </div>
            </div>
          )}
          <div style={{ display: "flex", gap: 12, margin: "20px 0" }}>
            <Stat label={data.live ? "발행된 게시글" : "생성된 미리보기"} value={data.posts.length} />
            <Stat label="발송된 DM" value={data.dmCount} />
          </div>
          {data.posts.length === 0 && (
            <p style={{ color: "#9aa0ae" }}>
              아직 게시물이 없습니다. 크론이 첫 실행되면 여기에 표시됩니다.
            </p>
          )}
          {data.posts.map((p: any) => (
            <div
              key={p.id}
              style={{
                display: "flex",
                gap: 14,
                background: "#1a1d24",
                border: "1px solid #2a2e38",
                borderRadius: 12,
                padding: 14,
                marginBottom: 10,
              }}
            >
              {p.image_url && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={p.image_url}
                  alt=""
                  width={72}
                  height={72}
                  style={{ borderRadius: 8, objectFit: "cover", flexShrink: 0 }}
                />
              )}
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontWeight: 600, display: "flex", gap: 8, alignItems: "center" }}>
                  {p.category === "맛집" ? "🍜" : "🏞️"} {p.place_name}
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
                <div style={{ color: "#9aa0ae", fontSize: 13, marginBottom: 6 }}>
                  {p.address} · {p.created_at}
                </div>
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
                  <PostActions caption={p.caption} imageUrl={p.image_url} />
                )}
              </div>
            </div>
          ))}
        </>
      )}
    </main>
  );
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
