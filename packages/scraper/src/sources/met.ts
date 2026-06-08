import path from "node:path";
import { z } from "zod";
import type { Artwork } from "../artwork.js";
import { ensureDir, fileExists } from "../fsutil.js";
import { getImageDimensions } from "../image-metadata.js";
import { downloadToFile } from "../net.js";
import { resizeToJpegs } from "../resize.js";

const MET_USER_AGENT = "paperlesspaper-art/0.1 (+local)";

const MetSearchResponse = z.object({
  objectIDs: z.array(z.number()).nullable().optional(),
});

const MetObject = z.object({
  objectID: z.number(),
  title: z.string().optional().nullable(),
  artistDisplayName: z.string().optional().nullable(),
  objectDate: z.string().optional().nullable(),
  classification: z.string().optional().nullable(),
  objectName: z.string().optional().nullable(),
  isPublicDomain: z.boolean().optional().nullable(),
  primaryImage: z.string().optional().nullable(),
  objectURL: z.string().optional().nullable(),
  creditLine: z.string().optional().nullable(),
});

export async function scrapeMet(params: {
  query: string;
  limit: number;
  widths: number[];
  imagesRoot: string;
  existingArtworkIds?: ReadonlySet<string>;
}) {
  const searchUrl = new URL(
    "https://collectionapi.metmuseum.org/public/collection/v1/search"
  );
  searchUrl.searchParams.set("hasImages", "true");
  searchUrl.searchParams.set("q", params.query);

  const searchRes = await metFetch(searchUrl);
  if (!searchRes.ok) {
    throw new Error(
      `Met search failed: ${searchRes.status} ${searchRes.statusText}`
    );
  }

  const searchJson = MetSearchResponse.parse(await searchRes.json());
  const ids = (searchJson.objectIDs ?? []).slice(0, params.limit);

  const artworks: Artwork[] = [];

  for (const objectID of ids) {
    if (params.existingArtworkIds?.has(`met:${objectID}`)) continue;

    const objectRes = await metFetch(
      `https://collectionapi.metmuseum.org/public/collection/v1/objects/${objectID}`
    );
    if (!objectRes.ok) continue;

    const obj = MetObject.parse(await objectRes.json());
    if (!obj.isPublicDomain) continue;
    if (!obj.primaryImage) continue;

    const sourceId = String(obj.objectID);
    const outDir = path.join(params.imagesRoot, "met", sourceId);
    await ensureDir(outDir);

    const originalPath = path.join(
      outDir,
      "original" + extFromUrl(obj.primaryImage)
    );
    const originalPublic = toPublicPath(params.imagesRoot, originalPath);

    try {
      await downloadToFile(obj.primaryImage, originalPath);
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

    const artwork: Artwork = {
      id: `met:${sourceId}`,
      source: "met",
      sourceId,
      title: obj.title ?? `Met ${sourceId}`,
      artist: emptyToUndefined(obj.artistDisplayName),
      date: emptyToUndefined(obj.objectDate),
      isPublicDomain: true,
      license: "Public Domain",
      rights: emptyToUndefined(obj.creditLine),
      sourceUrl:
        obj.objectURL ??
        `https://www.metmuseum.org/art/collection/search/${sourceId}`,
      image: {
        originalUrl: obj.primaryImage,
        ...dimensions,
        localOriginalPath: originalPublic,
        localResizedPaths: resized,
      },
      search: {
        query: params.query,
        downloadedAt: new Date().toISOString(),
      },
    };

    artworks.push(artwork);
  }

  return artworks;
}

// "All paintings" is not a first-class Met API endpoint.
// This uses Met /search with departmentId=11 (European Paintings) + query="painting" by default,
// then filters locally to paintings + public domain + has image.
export async function scrapeMetAllPaintings(params: {
  limit: number;
  offset: number;
  widths: number[];
  imagesRoot: string;
  concurrency: number;
  departmentId?: number;
  query?: string;
  existingArtworkIds?: ReadonlySet<string>;
}) {
  const departmentId = params.departmentId ?? 11;
  const query = params.query ?? "painting";

  const searchUrl = new URL(
    "https://collectionapi.metmuseum.org/public/collection/v1/search"
  );
  searchUrl.searchParams.set("hasImages", "true");
  searchUrl.searchParams.set("departmentId", String(departmentId));
  searchUrl.searchParams.set("q", query);

  const searchRes = await metFetch(searchUrl);
  if (!searchRes.ok) {
    throw new Error(
      `Met search failed: ${searchRes.status} ${searchRes.statusText}`
    );
  }

  const searchJson = MetSearchResponse.parse(await searchRes.json());
  const allIds = (searchJson.objectIDs ?? []).slice(params.offset);

  const results: Artwork[] = [];
  let index = 0;
  const workerCount = Math.max(1, Math.min(params.concurrency, 20));

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const i = index++;
        if (i >= allIds.length) return;
        if (results.length >= params.limit) return;

        const objectID = allIds[i];
        if (params.existingArtworkIds?.has(`met:${objectID}`)) continue;

        const artwork = await processMetObjectId({
          objectID,
          widths: params.widths,
          imagesRoot: params.imagesRoot,
          searchQuery: `paintings:${query}:dept-${departmentId}`,
          requirePainting: true,
        });

        if (artwork) results.push(artwork);
      }
    })
  );

  return results.slice(0, params.limit);
}

async function processMetObjectId(params: {
  objectID: number;
  widths: number[];
  imagesRoot: string;
  searchQuery: string;
  requirePainting: boolean;
}): Promise<Artwork | null> {
  let objectRes: Response;
  try {
    objectRes = await metFetch(
      `https://collectionapi.metmuseum.org/public/collection/v1/objects/${params.objectID}`
    );
  } catch {
    return null;
  }
  if (!objectRes.ok) return null;

  const obj = MetObject.parse(await objectRes.json());
  if (!obj.isPublicDomain) return null;
  if (!obj.primaryImage) return null;
  if (params.requirePainting && !isPainting(obj)) return null;

  const sourceId = String(obj.objectID);
  const outDir = path.join(params.imagesRoot, "met", sourceId);
  await ensureDir(outDir);

  const originalPath = path.join(outDir, "original" + extFromUrl(obj.primaryImage));
  const originalPublic = toPublicPath(params.imagesRoot, originalPath);

  if (!(await fileExists(originalPath))) {
    try {
      await downloadToFile(obj.primaryImage, originalPath);
    } catch {
      return null;
    }
  }

  const dimensions = await getImageDimensions(originalPath).catch(
    () => undefined
  );
  if (!dimensions) return null;

  const resized: Record<string, string> = {};
  const outByWidth: Record<number, string> = {};

  for (const w of params.widths) {
    const p = path.join(outDir, `w${w}.jpg`);
    resized[String(w)] = toPublicPath(params.imagesRoot, p);
    if (!(await fileExists(p))) outByWidth[w] = p;
  }

  if (Object.keys(outByWidth).length > 0) {
    await resizeToJpegs({ inputPath: originalPath, outputPathsByWidth: outByWidth });
  }

  return {
    id: `met:${sourceId}`,
    source: "met",
    sourceId,
    title: obj.title ?? `Met ${sourceId}`,
    artist: emptyToUndefined(obj.artistDisplayName),
    date: emptyToUndefined(obj.objectDate),
    isPublicDomain: true,
    license: "Public Domain",
    rights: emptyToUndefined(obj.creditLine),
    sourceUrl:
      obj.objectURL ?? `https://www.metmuseum.org/art/collection/search/${sourceId}`,
    image: {
      originalUrl: obj.primaryImage,
      ...dimensions,
      localOriginalPath: originalPublic,
      localResizedPaths: resized,
    },
    search: {
      query: params.searchQuery,
      downloadedAt: new Date().toISOString(),
    },
  };
}

function metFetch(url: string | URL) {
  return fetch(url, { headers: { "User-Agent": MET_USER_AGENT } });
}

function extFromUrl(url: string) {
  try {
    const pathname = new URL(url).pathname;
    const ext = path.extname(pathname);
    if (ext && ext.length <= 5) return ext;
    return ".jpg";
  } catch {
    return ".jpg";
  }
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

function isPainting(obj: z.infer<typeof MetObject>) {
  const classification = (obj.classification ?? "").toLowerCase();
  const objectName = (obj.objectName ?? "").toLowerCase();
  if (classification.includes("painting")) return true;
  if (objectName.includes("painting")) return true;
  return false;
}
