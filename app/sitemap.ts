import type { MetadataRoute } from "next";
import { SITE, allEditions, allPins, ymd } from "@/lib/publicmap";

export const revalidate = 3600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  try {
    const [pins, eds] = await Promise.all([allPins(), allEditions()]);
    return [
      { url: `${SITE}/m`, changeFrequency: "daily", priority: 1 },
      ...eds.map((e) => ({ url: `${SITE}/e/${encodeURIComponent(e.contentId)}`, lastModified: ymd(e.postedAt) || undefined, priority: 0.8 })),
      ...pins.map((p) => ({ url: `${SITE}/m/${p.id}`, lastModified: ymd(p.postedAt) || undefined, priority: 0.6 })),
    ];
  } catch {
    return [{ url: `${SITE}/m` }];
  }
}
