import path from "node:path";
import { z } from "zod";
import type { Artwork } from "../artwork.js";
import { ensureDir } from "../fsutil.js";
import { downloadToFile } from "../net.js";
import { resizeToJpegs } from "../resize.js";

const WikimediaApiResponse = z
  .object({
    query: z
      .object({
        pages: z
          .array(
            z.object({
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
            })
          )
          .optional(),
      })
      .optional(),
  })
  .passthrough();

const ALLOWED_RASTER_EXT = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const MIN_GLOBAL_USAGE = 0;
const MIN_LOCAL_USAGE = 0;

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
}) {
  const downloadedAt = new Date().toISOString();

  const apiUrl = new URL("https://commons.wikimedia.org/w/api.php");
  apiUrl.searchParams.set("action", "query");
  apiUrl.searchParams.set("format", "json");
  apiUrl.searchParams.set("formatversion", "2");
  apiUrl.searchParams.set("generator", "search");
  apiUrl.searchParams.set("gsrnamespace", "6"); // File:
  apiUrl.searchParams.set("gsrlimit", String(params.limit));
  apiUrl.searchParams.set("gsrsearch", params.query);
  apiUrl.searchParams.set("prop", "imageinfo|categories|globalusage|fileusage");
  apiUrl.searchParams.set("cllimit", "50");
  apiUrl.searchParams.set("clshow", "!hidden");
  apiUrl.searchParams.set("iiprop", "url|mime|size|extmetadata");
  apiUrl.searchParams.set("gulimit", "200");
  apiUrl.searchParams.set("gunamespace", "*");
  apiUrl.searchParams.set("fulimit", "200");
  apiUrl.searchParams.set("funamespace", "0|6|10|14|100|828");
  apiUrl.searchParams.set("redirects", "1");
  // Use a Wikimedia production thumbnail size to avoid 429 throttling on arbitrary widths.
  // See: https://www.mediawiki.org/wiki/Common_thumbnail_sizes
  apiUrl.searchParams.set("iiurlwidth", "1920");
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

  const res = await fetch(apiUrl);
  if (!res.ok) {
    throw new Error(`Wikimedia search failed: ${res.status} ${res.statusText}`);
  }

  const json = WikimediaApiResponse.parse(await res.json());
  const pages = json.query?.pages ?? [];

  const artworks: Artwork[] = [];

  for (const page of pages) {
    const ii = page.imageinfo?.[0];
    if (!ii) continue;

    const mime = (ii.mime ?? "").toLowerCase();
    const originalUrl = ii.thumburl ?? ii.url;
    if (!originalUrl) continue;

    if (!isAllowedRaster({ mime, url: originalUrl })) continue;

    const meta = ii.extmetadata ?? {};
    const licenseShort = ext(meta, "LicenseShortName");
    const licenseUrl = ext(meta, "LicenseUrl");
    const usageTerms = ext(meta, "UsageTerms");

    const licenseInfo = classifyLicense({
      licenseShort,
      licenseUrl,
      usageTerms,
    });
    if (!licenseInfo) continue;

    const sourceId = String(page.pageid);
    const title = pageTitleToDisplay(page.title);
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
      })
    ) {
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
      await downloadToFile(originalUrl, originalPath, {
        Referer: sourceUrl,
      });
    } catch {
      continue;
    }

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
      id: `wikimedia:${sourceId}`,
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
        localOriginalPath: originalPublic,
        localResizedPaths: resized,
      },
      search: {
        query: params.query,
        downloadedAt,
      },
    });
  }

  return artworks;
}

function isImportantCommonsFile(params: {
  globalUsageCount: number;
  localUsageCount: number;
  categories: Array<{ title: string }> | undefined;
}) {
  if (params.globalUsageCount >= MIN_GLOBAL_USAGE) return true;
  if (params.localUsageCount >= MIN_LOCAL_USAGE) return true;

  const categoryText = (params.categories ?? [])
    .map((c) => c.title)
    .map((t) => (t.startsWith("Category:") ? t.slice("Category:".length) : t))
    .map(normalizeForMatch)
    .join(" ");

  return IMPORTANT_CATEGORY_HINTS.some((hint) => categoryText.includes(hint));
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
