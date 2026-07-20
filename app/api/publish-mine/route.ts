import { after, NextRequest, NextResponse } from "next/server";
import sharp from "sharp";
import { db, initDb } from "@/lib/db";
import { generateMyCaption } from "@/lib/caption";
import { uploadPublicImage } from "@/lib/upload";
import { publishCarousel } from "@/lib/instagram";
import { searchMapUrl } from "@/lib/kakao";

export const maxDuration = 300;

// 내 사진으로 게시 — 대시보드 업로드 폼이 호출.
// multipart: images(File[]), name, region, category, note, secret
// 발행은 오래 걸리므로 즉시 응답 + after() 백그라운드 처리.
export async function POST(req: NextRequest) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "잘못된 요청" }, { status: 400 });
  }

  if (String(form.get("secret") ?? "") !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "비밀번호가 올바르지 않습니다" }, { status: 401 });
  }

  const files = form.getAll("images").filter((f): f is File => f instanceof File && f.size > 0);
  const name = String(form.get("name") ?? "").trim();
  const region = String(form.get("region") ?? "").trim();
  const category = String(form.get("category") ?? "맛집").trim();
  const note = String(form.get("note") ?? "").trim();

  if (files.length === 0) return NextResponse.json({ error: "사진을 1장 이상 올려주세요" }, { status: 400 });
  if (!name) return NextResponse.json({ error: "상호명/장소명을 입력해주세요" }, { status: 400 });

  // 이미지 표준화(4:5, 1080x1350 jpeg) — 미리 처리해 발행 실패 줄임
  const buffers: Buffer[] = [];
  for (const f of files.slice(0, 10)) {
    const raw = Buffer.from(await f.arrayBuffer());
    const jpg = await sharp(raw).rotate().resize(1080, 1350, { fit: "cover" }).jpeg({ quality: 88 }).toBuffer();
    buffers.push(jpg);
  }

  await initDb();
  await db.execute({
    sql: "INSERT INTO cron_log (note) VALUES (?)",
    args: [`내사진 업로드 접수: ${name} (${buffers.length}장)`],
  }).catch(() => {});

  // 백그라운드에서 업로드→발행 (응답은 즉시)
  after(async () => {
    try {
      const urls: string[] = [];
      for (let i = 0; i < buffers.length; i++) {
        urls.push(await uploadPublicImage(buffers[i], `mine-${i}`));
      }
      const mapUrl = searchMapUrl(name, region);
      const caption = await generateMyCaption({ name, region, category, note, mapUrl });

      const dryRun = !process.env.IG_ACCESS_TOKEN || !process.env.IG_USER_ID;
      const mediaId = dryRun ? null : await publishCarousel(urls, caption);

      await db.execute({
        sql: `INSERT INTO posts (content_id, place_name, address, category, image_url, image_urls, caption, ig_media_id, status, map_url)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          `mine-${Date.now()}`,
          name,
          region,
          category,
          urls[0],
          JSON.stringify(urls),
          caption,
          mediaId,
          dryRun ? "dry_run" : "published",
          mapUrl,
        ],
      });
      await db.execute({
        sql: "INSERT INTO cron_log (note) VALUES (?)",
        args: [`내사진 발행 ${dryRun ? "(미리보기)" : "완료"}: ${name} | media=${mediaId ?? "-"}`],
      }).catch(() => {});
    } catch (e) {
      await db
        .execute({ sql: "INSERT INTO cron_log (note) VALUES (?)", args: [`내사진 발행 실패: ${String(e).slice(0, 300)}`] })
        .catch(() => {});
    }
  });

  return NextResponse.json({ accepted: true, message: `${name} — ${buffers.length}장 접수. 잠시 후 발행됩니다.` });
}
