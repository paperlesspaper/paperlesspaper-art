import path from "node:path";
import { z } from "zod";
import type { Artwork } from "../artwork.js";
import { ensureDir } from "../fsutil.js";
import { getImageDimensions } from "../image-metadata.js";
import { downloadToFile } from "../net.js";
import { resizeToJpegs } from "../resize.js";

const ArticSearchResponse = z.object({
  data: z.array(
    z.object({
      id: z.number(),
      title: z.string().optional().nullable(),
    })
  ),
});

const ArticArtworkResponse = z.object({
  data: z.object({
    id: z.number(),
    title: z.string().optional().nullable(),
    image_id: z.string().optional().nullable(),
    artist_title: z.string().optional().nullable(),
    date_display: z.string().optional().nullable(),
    is_public_domain: z.boolean().optional().nullable(),
    api_link: z.string().optional().nullable(),
    copyright_notice: z.string().optional().nullable(),
  }),
});

export async function scrapeArtic(params: {
  query: string;
  limit: number;
  widths: number[];
  imagesRoot: string;
  existingArtworkIds?: ReadonlySet<string>;
}) {
  const searchUrl = new URL("https://api.artic.edu/api/v1/artworks/search");
  searchUrl.searchParams.set("q", params.query);
  searchUrl.searchParams.set("limit", String(params.limit));
  searchUrl.searchParams.set("fields", "id,title");

  const searchRes = await fetch(searchUrl);
  if (!searchRes.ok) {
    throw new Error(
      `ArtIC search failed: ${searchRes.status} ${searchRes.statusText}`
    );
  }

  const searchJson = ArticSearchResponse.parse(await searchRes.json());

  const artworks: Artwork[] = [];

  for (const item of searchJson.data) {
    if (params.existingArtworkIds?.has(`artic:${item.id}`)) continue;

    const detailsUrl = new URL(
      `https://api.artic.edu/api/v1/artworks/${item.id}`
    );
    detailsUrl.searchParams.set(
      "fields",
      "id,title,image_id,artist_title,date_display,is_public_domain,api_link,copyright_notice"
    );

    const detailsRes = await fetch(detailsUrl);
    if (!detailsRes.ok) continue;
    const details = ArticArtworkResponse.parse(await detailsRes.json()).data;

    if (!details.is_public_domain) continue;
    if (!details.image_id) continue;

    const sourceId = String(details.id);
    const originalUrl = `https://www.artic.edu/iiif/2/${details.image_id}/full/full/0/default.jpg`;

    const outDir = path.join(params.imagesRoot, "artic", sourceId);
    await ensureDir(outDir);

    const originalPath = path.join(outDir, "original.jpg");
    const originalPublic = toPublicPath(params.imagesRoot, originalPath);

    try {
      await downloadToFile(originalUrl, originalPath, {
        Referer: `https://www.artic.edu/artworks/${sourceId}`,
      });
    } catch {
      continue;
    }

    const dimensions = await getImageDimensions(originalPath).catch(
      () => undefined
    );
    if (!dimensions) continue;

    const resized: Record<string, string> = {};
    const outByWidth: Record<number, string> = {};

    for (const w of params.widths) {
      const p = path.join(outDir, `w${w}.jpg`);
      outByWidth[w] = p;
      resized[String(w)] = toPublicPath(params.imagesRoot, p);
    }

    await resizeToJpegs({
      inputPath: originalPath,
      outputPathsByWidth: outByWidth,
    });

    artworks.push({
      id: `artic:${sourceId}`,
      source: "artic",
      sourceId,
      title: details.title ?? `ArtIC ${sourceId}`,
      artist: emptyToUndefined(details.artist_title),
      date: emptyToUndefined(details.date_display),
      isPublicDomain: true,
      license: "Public Domain",
      rights: emptyToUndefined(details.copyright_notice),
      sourceUrl: `https://www.artic.edu/artworks/${sourceId}`,
      image: {
        originalUrl,
        ...dimensions,
        localOriginalPath: originalPublic,
        localResizedPaths: resized,
      },
      search: {
        query: params.query,
        downloadedAt: new Date().toISOString(),
      },
    });
  }

  return artworks;
}

function toPublicPath(imagesRoot: string, filePath: string) {
  const rel = path.relative(imagesRoot, filePath).split(path.sep).join("/");
  return `/images/${rel}`;
}

function emptyToUndefined(value: string | null | undefined) {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}
