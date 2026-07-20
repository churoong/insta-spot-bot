import { createClient, type Client } from "@libsql/client";

let client: Client | null = null;

// 빌드 시점에는 환경변수가 없을 수 있어 첫 사용 시점에 생성
export const db: Client = new Proxy({} as Client, {
  get(_, prop) {
    if (!client) {
      // 배포: Turso(호스팅 SQLite). 로컬: TURSO_DATABASE_URL이 없으면 파일 SQLite로 폴백.
      // 같은 코드로 로컬 개발/테스트와 프로덕션을 모두 커버.
      const url = process.env.TURSO_DATABASE_URL || "file:local.db";
      client = createClient({
        url,
        authToken: process.env.TURSO_AUTH_TOKEN,
      });
    }
    const value = (client as any)[prop];
    // 메서드는 실제 클라이언트에 바인딩해서 반환 (로컬 Sqlite3Client는 this 바인딩 필수)
    return typeof value === "function" ? value.bind(client) : value;
  },
});

let initialized = false;

export async function initDb() {
  if (initialized) return;
  await db.batch(
    [
      `CREATE TABLE IF NOT EXISTS posts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content_id TEXT UNIQUE,
        place_name TEXT NOT NULL,
        address TEXT,
        category TEXT,
        image_url TEXT,
        image_urls TEXT,
        caption TEXT,
        ig_media_id TEXT,
        status TEXT DEFAULT 'published',
        created_at TEXT DEFAULT (datetime('now'))
      )`,
      `CREATE TABLE IF NOT EXISTS dm_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        comment_id TEXT UNIQUE,
        ig_media_id TEXT,
        username TEXT,
        sent_at TEXT DEFAULT (datetime('now'))
      )`,
      `CREATE INDEX IF NOT EXISTS idx_posts_media ON posts(ig_media_id)`,
      `CREATE TABLE IF NOT EXISTS webhook_debug (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sig_ok INTEGER,
        note TEXT,
        raw TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )`,
      `CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at TEXT DEFAULT (datetime('now'))
      )`,
      `CREATE TABLE IF NOT EXISTS cron_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        note TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )`,
      `CREATE TABLE IF NOT EXISTS follower_log (
        date TEXT PRIMARY KEY,
        count INTEGER,
        created_at TEXT DEFAULT (datetime('now'))
      )`,
      `CREATE TABLE IF NOT EXISTS comment_suggestions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        comment_id TEXT UNIQUE,
        username TEXT,
        text TEXT,
        ig_media_id TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )`,
    ],
    "write"
  );

  // 기존 테이블 마이그레이션: 없는 컬럼 추가 (이미 있으면 에러 무시)
  const migrations = [
    "ALTER TABLE posts ADD COLUMN image_urls TEXT",
    "ALTER TABLE posts ADD COLUMN mapx TEXT",
    "ALTER TABLE posts ADD COLUMN mapy TEXT",
    "ALTER TABLE posts ADD COLUMN like_count INTEGER DEFAULT 0",
    "ALTER TABLE posts ADD COLUMN comment_count INTEGER DEFAULT 0",
    "ALTER TABLE posts ADD COLUMN featured_by TEXT",
    "ALTER TABLE posts ADD COLUMN revealed INTEGER DEFAULT 0",
  ];
  for (const sql of migrations) {
    try {
      await db.execute(sql);
    } catch {
      /* 이미 존재 */
    }
  }

  initialized = true;
}
