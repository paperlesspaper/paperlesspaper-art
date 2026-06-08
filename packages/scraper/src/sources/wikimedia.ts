import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Artwork } from "../artwork.js";
import { ensureDir } from "../fsutil.js";
import { getImageDimensions } from "../image-metadata.js";
import {
  HttpError,
  downloadToFile,
  fetchWithBackoff,
  parseRetryAfterMs,
} from "../net.js";
import { resizeToJpegs } from "../resize.js";

const WikimediaPage = z.object({
  pageid: z.number(),
  title: z.string(),
  imageinfo: z
    .array(
      z.object({
        url: z.string().optional(),
        thumburl: z.string().optional(),
        mime: z.string().optional(),
        extmetadata: z.record(z.string(), z.any()).optional(),
      })
    )
    .optional(),
  categories: z.array(z.object({ title: z.string() })).optional(),
  globalusage: z
    .array(z.object({ title: z.string().optional() }).passthrough())
    .optional(),
  fileusage: z
    .array(z.object({ title: z.string().optional() }).passthrough())
    .optional(),
});

type WikimediaPage = z.infer<typeof WikimediaPage>;

const WikimediaApiResponse = z
  .object({
    query: z
      .object({
        pages: z.array(WikimediaPage).optional(),
      })
      .optional(),
  })
  .passthrough();

const WikimediaCategoryMembersResponse = z
  .object({
    continue: z.record(z.string(), z.any()).optional(),
    query: z
      .object({
        categorymembers: z
          .array(
            z.object({
              pageid: z.number(),
              ns: z.number(),
              title: z.string(),
            })
          )
          .optional(),
      })
      .optional(),
  })
  .passthrough();

const ALLOWED_RASTER_EXT = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const DEFAULT_MIN_GLOBAL_USAGE = 0;
const DEFAULT_MIN_LOCAL_USAGE = 0;
const DEFAULT_THUMB_WIDTH = 1024;
const DEFAULT_DOWNLOAD_DELAY_MS = 1000;
const DEFAULT_CATEGORY_DEPTH = 5;
const DEFAULT_API_DELAY_MS = 250;

const INCLUDED_ART_HINTS = [
  "painting",
  "paintings",
  "oil on canvas",
  "watercolor",
  "watercolors",
  "drawing",
  "drawings",
  "sketch",
  "sketches",
  "illustration",
  "illustrations",
  "print",
  "prints",
  "engraving",
  "engravings",
  "photograph",
  "photographs",
  "photography",
  "portrait",
  "portraits",
  "landscape",
  "landscapes",
  "still life",
  "still lifes",
  "artwork",
  "artworks",
  "fine art",
  "Google Art Project",
];

const EXCLUDED_NON_ART_HINTS = [
  "logo",
  "logos",
  "icon",
  "icons",
  "pictogram",
  "pictograms",
  "symbol",
  "symbols",
  "flag",
  "flags",
  "coat of arms",
  "map",
  "maps",
  "diagram",
  "diagrams",
  "chart",
  "charts",
  "schematic",
  "schematics",
  "technical drawing",
  "technical drawings",
  "screenshot",
  "screenshots",
  "user interface",
  "road sign",
  "road signs",
  "signage",
];

const IMPORTANT_CATEGORY_HINTS = [
  "featured pictures on wikimedia commons",
  "valued images on wikimedia commons",
  "quality images on wikimedia commons",
];

export async function scrapeWikimedia(params: {
  query: string;
  limit: number;
  widths: number[];
  imagesRoot: string;
  minGlobalUsage?: number;
  minLocalUsage?: number;
  thumbWidth?: number;
  downloadDelayMs?: number;
  searchOffset?: number;
  category?: string;
  categoryDepth?: number;
  existingArtworkIds?: ReadonlySet<string>;
}) {
  const downloadedAt = new Date().toISOString();
  const minGlobalUsage = normalizeUsageThreshold(
    params.minGlobalUsage,
    DEFAULT_MIN_GLOBAL_USAGE
  );
  const minLocalUsage = normalizeUsageThreshold(
    params.minLocalUsage,
    DEFAULT_MIN_LOCAL_USAGE
  );
  const thumbWidth = normalizeUsageThreshold(
    params.thumbWidth,
    DEFAULT_THUMB_WIDTH
  );
  const downloadDelayMs = normalizeUsageThreshold(
    params.downloadDelayMs,
    DEFAULT_DOWNLOAD_DELAY_MS
  );
  const searchOffset = normalizeUsageThreshold(params.searchOffset, 0);
  const categoryDepth = normalizeUsageThreshold(
    params.categoryDepth,
    DEFAULT_CATEGORY_DEPTH
  );
  const maxlag = normalizeUsageThreshold(
    Number(process.env.WIKIMEDIA_MAXLAG ?? "5"),
    5
  );
  const apiDelayMs = normalizeUsageThreshold(
    Number(process.env.WIKIMEDIA_API_DELAY_MS ?? String(DEFAULT_API_DELAY_MS)),
    DEFAULT_API_DELAY_MS
  );
  const resultLimit = normalizeResultLimit(params.limit);

  const pages = params.category
    ? await fetchWikimediaCategoryPages({
        category: params.category,
        depth: categoryDepth,
        limit: resultLimit,
        thumbWidth,
        maxlag,
        apiDelayMs,
      })
    : await fetchWikimediaSearchPages({
        query: params.query,
        limit: resultLimit,
        searchOffset,
        thumbWidth,
        maxlag,
        apiDelayMs,
      });

  const artworks: Artwork[] = [];
  const seenTitleKeys = new Set<string>();
  const stats = {
    pages: pages.length,
    searchOffset,
    category: params.category,
    categoryDepth: params.category ? categoryDepth : undefined,
    accepted: 0,
    skippedNoImageInfo: 0,
    skippedNoImageUrl: 0,
    skippedType: 0,
    skippedLicense: 0,
    skippedDuplicateTitle: 0,
    skippedExisting: 0,
    skippedNonArt: 0,
    skippedUsage: 0,
    skippedDownload: 0,
    skippedMetadata: 0,
    skippedResize: 0,
  };

  for (const page of pages) {
    const ii = page.imageinfo?.[0];
    if (!ii) {
      stats.skippedNoImageInfo++;
      continue;
    }

    const mime = (ii.mime ?? "").toLowerCase();
    const originalUrl = ii.thumburl ?? ii.url;
    if (!originalUrl) {
      stats.skippedNoImageUrl++;
      continue;
    }

    if (!isAllowedRaster({ mime, url: originalUrl })) {
      stats.skippedType++;
      continue;
    }

    const meta = ii.extmetadata ?? {};
    const licenseShort = ext(meta, "LicenseShortName");
    const licenseUrl = ext(meta, "LicenseUrl");
    const usageTerms = ext(meta, "UsageTerms");

    const licenseInfo = classifyLicense({
      licenseShort,
      licenseUrl,
      usageTerms,
    });
    if (!licenseInfo) {
      stats.skippedLicense++;
      continue;
    }

    const sourceId = String(page.pageid);
    const id = `wikimedia:${sourceId}`;
    if (params.existingArtworkIds?.has(id)) {
      stats.skippedExisting++;
      continue;
    }

    const title = pageTitleToDisplay(page.title);
    const titleKey = normalizeTitleForDedupe(title);
    if (titleKey && seenTitleKeys.has(titleKey)) {
      stats.skippedDuplicateTitle++;
      continue;
    }
    const sourceUrl = pageTitleToUrl(page.title);

    const description =
      ext(meta, "ObjectName") || ext(meta, "ImageDescription") || undefined;

    if (
      !looksLikeScreenArt({
        query: params.query,
        title,
        description,
        categories: page.categories,
      })
    ) {
      stats.skippedNonArt++;
      continue;
    }

    const globalUsageCount = page.globalusage?.length ?? 0;
    const localUsageCount = page.fileusage?.length ?? 0;
    console.log(
      `Wikimedia file ${page.title} has global usage ${globalUsageCount} and local usage ${localUsageCount}`
    );

    if (
      !isImportantCommonsFile({
        globalUsageCount,
        localUsageCount,
        categories: page.categories,
        minGlobalUsage,
        minLocalUsage,
      })
    ) {
      stats.skippedUsage++;
      continue;
    }

    const artist = ext(meta, "Artist") || undefined;
    const date = ext(meta, "DateTimeOriginal") || undefined;
    const credit = ext(meta, "Credit") || undefined;

    const outDir = path.join(params.imagesRoot, "wikimedia", sourceId);
    await ensureDir(outDir);

    const originalExt = extFromMimeOrUrl(mime, originalUrl);
    const originalPath = path.join(outDir, `original${originalExt}`);
    const originalPublic = toPublicPath(params.imagesRoot, originalPath);

    try {
      if (downloadDelayMs > 0) await sleep(downloadDelayMs);
      await downloadToFile(originalUrl, originalPath, {
        Referer: sourceUrl,
      });
    } catch (error) {
      stats.skippedDownload++;
      await removeEmptyOutputDir(outDir);
      console.warn(`Wikimedia download failed for ${page.title}: ${errorMessage(error)}`);
      continue;
    }

    const dimensions = await getImageDimensions(originalPath).catch(
      () => undefined
    );
    if (!dimensions) {
      stats.skippedMetadata++;
      await removeOutputDir(outDir);
      console.warn(`Wikimedia metadata failed for ${page.title}`);
      continue;
    }

    const resized: Record<string, string> = {};
    const outByWidth: Record<number, string> = {};

    for (const w of params.widths) {
      const p = path.join(outDir, `w${w}.jpg`);
      outByWidth[w] = p;
      resized[String(w)] = toPublicPath(params.imagesRoot, p);
    }

    try {
      await resizeToJpegs({
        inputPath: originalPath,
        outputPathsByWidth: outByWidth,
      });
    } catch (error) {
      stats.skippedResize++;
      await removeOutputDir(outDir);
      console.warn(`Wikimedia resize failed for ${page.title}: ${errorMessage(error)}`);
      continue;
    }

    if (titleKey) seenTitleKeys.add(titleKey);
    stats.accepted++;

    artworks.push({
      id,
      source: "wikimedia",
      sourceId,
      title,
      description,
      artist,
      date,
      isPublicDomain: licenseInfo.isPublicDomain,
      license: licenseInfo.license,
      licenseUrl: licenseInfo.licenseUrl,
      rights: credit,
      sourceUrl,
      tags: categoriesToTags(page.categories),
      image: {
        originalUrl,
        ...dimensions,
        localOriginalPath: originalPublic,
        localResizedPaths: resized,
      },
      search: {
        query: params.query,
        downloadedAt,
      },
    });
  }

  console.log(`Wikimedia scrape stats: ${JSON.stringify(stats)}`);
  return artworks;
}

async function fetchWikimediaSearchPages(params: {
  query: string;
  limit: number;
  searchOffset: number;
  thumbWidth: number;
  maxlag: number;
  apiDelayMs: number;
}) {
  const apiUrl = baseWikimediaPagesUrl({
    thumbWidth: params.thumbWidth,
    maxlag: params.maxlag,
  });
  apiUrl.searchParams.set("generator", "search");
  apiUrl.searchParams.set("gsrnamespace", "6"); // File:
  apiUrl.searchParams.set(
    "gsrlimit",
    String(Math.min(params.limit, 500))
  );
  apiUrl.searchParams.set("gsrsearch", params.query);
  if (params.searchOffset > 0) {
    apiUrl.searchParams.set("gsroffset", String(params.searchOffset));
  }

  return fetchWikimediaPages(apiUrl, params.apiDelayMs);
}

async function fetchWikimediaCategoryPages(params: {
  category: string;
  depth: number;
  limit: number;
  thumbWidth: number;
  maxlag: number;
  apiDelayMs: number;
}) {
  const pageIds = await collectWikimediaCategoryFileIds({
    category: params.category,
    depth: params.depth,
    limit: params.limit,
    maxlag: params.maxlag,
    apiDelayMs: params.apiDelayMs,
  });
  const pages: WikimediaPage[] = [];

  for (const batch of chunks(pageIds, 50)) {
    const apiUrl = baseWikimediaPagesUrl({
      thumbWidth: params.thumbWidth,
      maxlag: params.maxlag,
    });
    apiUrl.searchParams.set("pageids", batch.join("|"));
    pages.push(...(await fetchWikimediaPages(apiUrl, params.apiDelayMs)));
  }

  return pages;
}

async function collectWikimediaCategoryFileIds(params: {
  category: string;
  depth: number;
  limit: number;
  maxlag: number;
  apiDelayMs: number;
}) {
  const rootCategory = normalizeCategoryTitle(params.category);
  const queue: Array<{ title: string; depth: number }> = [
    { title: rootCategory, depth: 0 },
  ];
  const seenCategories = new Set<string>();
  const seenPageIds = new Set<number>();
  const pageIds: number[] = [];

  while (queue.length > 0) {
    if (pageIds.length >= params.limit) break;

    const current = queue.shift();
    if (!current) break;

    const categoryKey = normalizeCategoryTitle(current.title);
    if (seenCategories.has(categoryKey)) continue;
    seenCategories.add(categoryKey);
    console.log(
      `Wikimedia category ${seenCategories.size}: ${categoryKey} (depth ${current.depth}, files ${pageIds.length})`
    );

    let cmcontinue: string | undefined;
    do {
      const apiUrl = new URL("https://commons.wikimedia.org/w/api.php");
      apiUrl.searchParams.set("action", "query");
      apiUrl.searchParams.set("format", "json");
      apiUrl.searchParams.set("formatversion", "2");
      apiUrl.searchParams.set("list", "categorymembers");
      apiUrl.searchParams.set("cmtitle", categoryKey);
      apiUrl.searchParams.set("cmtype", "file|subcat");
      apiUrl.searchParams.set("cmlimit", "500");
      if (cmcontinue) apiUrl.searchParams.set("cmcontinue", cmcontinue);
      if (params.maxlag > 0) {
        apiUrl.searchParams.set("maxlag", String(params.maxlag));
      }

      if (params.apiDelayMs > 0) await sleep(params.apiDelayMs);
      const res = await fetchWithBackoff(apiUrl);
      if (!res.ok) {
        throw new HttpError({
          status: res.status,
          statusText: res.statusText,
          url: String(apiUrl),
          retryAfterMs: parseRetryAfterMs(res.headers),
        });
      }

      const json = WikimediaCategoryMembersResponse.parse(await res.json());
      const members = json.query?.categorymembers ?? [];

      for (const member of members) {
        if (member.ns === 6 && !seenPageIds.has(member.pageid)) {
          seenPageIds.add(member.pageid);
          pageIds.push(member.pageid);
          if (pageIds.length >= params.limit) break;
        }

        if (member.ns === 14 && current.depth < params.depth) {
          const subcategory = normalizeCategoryTitle(member.title);
          if (!seenCategories.has(subcategory)) {
            queue.push({ title: subcategory, depth: current.depth + 1 });
          }
        }
      }

      cmcontinue = json.continue?.cmcontinue;
    } while (cmcontinue && pageIds.length < params.limit);
  }

  console.log(
    `Wikimedia category scan: ${JSON.stringify({
      category: rootCategory,
      depth: params.depth,
      categories: seenCategories.size,
      files: pageIds.length,
    })}`
  );

  return pageIds;
}

function baseWikimediaPagesUrl(params: { thumbWidth: number; maxlag: number }) {
  const apiUrl = new URL("https://commons.wikimedia.org/w/api.php");
  apiUrl.searchParams.set("action", "query");
  apiUrl.searchParams.set("format", "json");
  apiUrl.searchParams.set("formatversion", "2");
  apiUrl.searchParams.set("prop", "imageinfo|categories|globalusage|fileusage");
  apiUrl.searchParams.set("cllimit", "50");
  apiUrl.searchParams.set("clshow", "!hidden");
  apiUrl.searchParams.set("iiprop", "url|mime|size|extmetadata");
  apiUrl.searchParams.set("gulimit", "200");
  apiUrl.searchParams.set("gunamespace", "*");
  apiUrl.searchParams.set("fulimit", "200");
  apiUrl.searchParams.set("funamespace", "0|6|10|14|100|828");
  apiUrl.searchParams.set("redirects", "1");
  if (params.maxlag > 0) {
    apiUrl.searchParams.set("maxlag", String(params.maxlag));
  }
  // Request a larger source thumbnail while still avoiding full original files.
  // See: https://www.mediawiki.org/wiki/Common_thumbnail_sizes
  apiUrl.searchParams.set("iiurlwidth", String(params.thumbWidth));
  apiUrl.searchParams.set(
    "iiextmetadatafilter",
    [
      "LicenseShortName",
      "LicenseUrl",
      "UsageTerms",
      "Credit",
      "Artist",
      "ImageDescription",
      "DateTimeOriginal",
      "DateTime",
      "Date",
      "ObjectName",
    ].join("|")
  );

  return apiUrl;
}

async function fetchWikimediaPages(apiUrl: URL, apiDelayMs: number) {
  if (apiDelayMs > 0) await sleep(apiDelayMs);
  const res = await fetchWithBackoff(apiUrl);
  if (!res.ok) {
    throw new HttpError({
      status: res.status,
      statusText: res.statusText,
      url: String(apiUrl),
      retryAfterMs: parseRetryAfterMs(res.headers),
    });
  }

  const json = WikimediaApiResponse.parse(await res.json());
  return json.query?.pages ?? [];
}

function isImportantCommonsFile(params: {
  globalUsageCount: number;
  localUsageCount: number;
  categories: Array<{ title: string }> | undefined;
  minGlobalUsage: number;
  minLocalUsage: number;
}) {
  if (params.globalUsageCount >= params.minGlobalUsage) return true;
  if (params.localUsageCount >= params.minLocalUsage) return true;

  const categoryText = (params.categories ?? [])
    .map((c) => c.title)
    .map((t) => (t.startsWith("Category:") ? t.slice("Category:".length) : t))
    .map(normalizeForMatch)
    .join(" ");

  return IMPORTANT_CATEGORY_HINTS.some((hint) => categoryText.includes(hint));
}

function normalizeUsageThreshold(value: unknown, fallback: number) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return fallback;
  }

  return Math.trunc(value);
}

function normalizeResultLimit(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 25;
  }

  if (value <= 0) return Number.POSITIVE_INFINITY;
  return Math.trunc(value);
}

function normalizeCategoryTitle(value: string) {
  const trimmed = value.trim().replace(/_/g, " ");
  return trimmed.startsWith("Category:") ? trimmed : `Category:${trimmed}`;
}

function chunks<T>(items: T[], size: number) {
  const result: T[][] = [];

  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }

  return result;
}

async function removeEmptyOutputDir(dir: string) {
  try {
    await fs.rmdir(dir);
  } catch {
    // Keep non-empty directories intact.
  }
}

async function removeOutputDir(dir: string) {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function looksLikeScreenArt(params: {
  query: string;
  title: string;
  description?: string;
  categories: Array<{ title: string }> | undefined;
}) {
  const categoryText = (params.categories ?? []).map((c) => c.title).join(" ");
  const haystack = normalizeForMatch(
    [params.query, params.title, params.description, categoryText]
      .filter(Boolean)
      .join(" ")
  );

  // if (EXCLUDED_NON_ART_HINTS.some((t) => haystack.includes(t))) return false;
  if (INCLUDED_ART_HINTS.some((t) => haystack.includes(t))) return true;
  return true;
  // Default to conservative behavior: only accept when we have a positive signal.
  return false;
}

function normalizeForMatch(value: string) {
  return value.toLowerCase().replace(/_/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeTitleForDedupe(value: string) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/lccn\d+/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function pageTitleToUrl(title: string) {
  const normalized = title.replace(/ /g, "_");
  return `https://commons.wikimedia.org/wiki/${encodeURIComponent(normalized)}`;
}

function pageTitleToDisplay(title: string) {
  // File:Foo.jpg -> Foo
  const withoutNs = title.startsWith("File:")
    ? title.slice("File:".length)
    : title;
  return withoutNs.replace(/_/g, " ").replace(/\.[a-z0-9]{2,5}$/i, "");
}

function categoriesToTags(
  categories: Array<{ title: string }> | undefined
): string[] | undefined {
  if (!categories || categories.length === 0) return undefined;
  const tags = categories
    .map((c) => c.title)
    .map((t) => (t.startsWith("Category:") ? t.slice("Category:".length) : t))
    .map((t) => t.replace(/_/g, " ").trim())
    .filter((t) => t.length > 0);
  return tags.length > 0 ? tags.slice(0, 25) : undefined;
}

function toPublicPath(imagesRoot: string, filePath: string) {
  const rel = path.relative(imagesRoot, filePath).split(path.sep).join("/");
  return `/images/${rel}`;
}

function extFromMimeOrUrl(mime: string, url: string) {
  if (mime === "image/jpeg") return ".jpg";
  if (mime === "image/png") return ".png";
  if (mime === "image/webp") return ".webp";

  try {
    const pathname = new URL(url).pathname;
    const ext = path.extname(pathname);
    if (ext && ext.length <= 6) return ext;
  } catch {
    // ignore
  }

  return ".jpg";
}

function isAllowedRaster(params: { mime: string; url: string }) {
  const mime = params.mime;
  if (mime.includes("svg")) return false;
  if (mime === "image/gif") return false;

  if (mime.startsWith("image/")) return true;

  try {
    const ext = path.extname(new URL(params.url).pathname).toLowerCase();
    if (ALLOWED_RASTER_EXT.has(ext)) return true;
    if (ext === ".gif" || ext === ".svg") return false;
  } catch {
    // ignore
  }

  return false;
}

function ext(meta: Record<string, any>, key: string) {
  const raw = meta?.[key]?.value;
  if (typeof raw !== "string") return undefined;
  const stripped = stripHtml(raw);
  return stripped.length > 0 ? stripped : undefined;
}

function stripHtml(value: string) {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function classifyLicense(params: {
  licenseShort?: string;
  licenseUrl?: string;
  usageTerms?: string;
}): { license: string; licenseUrl?: string; isPublicDomain: boolean } | null {
  const licenseShort = params.licenseShort?.trim();
  const licenseUrl = params.licenseUrl?.trim();
  const usageTerms = params.usageTerms?.trim();

  const haystack = [licenseShort, licenseUrl, usageTerms]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (haystack.includes("non-free") || haystack.includes("fair use"))
    return null;

  const isCc =
    (typeof licenseUrl === "string" &&
      licenseUrl.includes("creativecommons.org/")) ||
    (typeof licenseShort === "string" &&
      licenseShort.toUpperCase().includes("CC")) ||
    haystack.includes("creative commons");

  const isPd =
    haystack.includes("public domain") ||
    haystack.includes("cc0") ||
    (typeof licenseShort === "string" && /^pd/i.test(licenseShort));

  if (!isCc && !isPd) return null;

  return {
    license:
      licenseShort ??
      usageTerms ??
      (isPd ? "Public Domain" : "Creative Commons"),
    licenseUrl,
    isPublicDomain: isPd,
  };
}
