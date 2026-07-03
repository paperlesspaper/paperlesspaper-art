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

type WikimediaPreviewDecision = "pending" | "approved" | "rejected";

type WikimediaPreviewDecisionRecord = {
  id: string;
  sourceId: string;
  title: string;
  query: string;
  decision: WikimediaPreviewDecision;
  previewUrl: string;
  previewLocalPath: string;
  sourceUrl: string;
  decidedAt: string;
  metadata: Record<string, unknown>;
};

type WikimediaArtFilterMode = "broad" | "strict";
type WikimediaReviewMode = "both" | "previews" | "full";

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
const DEFAULT_PREVIEW_WIDTH = 160;
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
  allowDuplicateTitles?: boolean;
  revisitRejectedPreviews?: boolean;
  disableCandidateFilters?: boolean;
  ignoreUsageFilter?: boolean;
  artFilterMode?: WikimediaArtFilterMode;
  reviewMode?: WikimediaReviewMode;
  fullDownloadConcurrency?: number;
  downloadDelayMs?: number;
  searchOffset?: number;
  category?: string;
  categoryDepth?: number;
  existingArtworkIds?: ReadonlySet<string>;
  existingPreviewDecisions?: ReadonlyMap<string, WikimediaPreviewDecision>;
  previewReview?: boolean;
  previewWidth?: number;
  onArtwork?: (artwork: Artwork) => Promise<void>;
  onPreviewDecision?: (
    decision: WikimediaPreviewDecisionRecord
  ) => Promise<void>;
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
  const previewWidth = Math.max(
    64,
    normalizeUsageThreshold(params.previewWidth, DEFAULT_PREVIEW_WIDTH)
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
  const pageBatchSize = Math.max(
    1,
    normalizeUsageThreshold(
      Number(process.env.WIKIMEDIA_PAGE_BATCH_SIZE ?? "20"),
      20
    )
  );
  const resultLimit = normalizeResultLimit(params.limit);
  const previewReview = params.previewReview === true;
  const allowDuplicateTitles = params.allowDuplicateTitles === true;
  const revisitRejectedPreviews = params.revisitRejectedPreviews === true;
  const disableCandidateFilters = params.disableCandidateFilters === true;
  const ignoreUsageFilter = params.ignoreUsageFilter === true;
  const artFilterMode =
    params.artFilterMode === "strict" ? "strict" : "broad";
  const reviewMode =
    params.reviewMode === "previews" || params.reviewMode === "full"
      ? params.reviewMode
      : "both";
  const previewOnly = previewReview && reviewMode === "previews";
  const fullOnly = previewReview && reviewMode === "full";
  const fullDownloadConcurrency = Math.max(
    1,
    Math.min(
      8,
      normalizeUsageThreshold(params.fullDownloadConcurrency, 3)
    )
  );
  const includeUsage =
    !disableCandidateFilters &&
    !ignoreUsageFilter &&
    (minGlobalUsage > 0 || minLocalUsage > 0);
  const metadataThumbWidth = previewReview ? previewWidth : thumbWidth;

  const pages = params.category
    ? await fetchWikimediaCategoryPages({
        category: params.category,
        depth: categoryDepth,
        limit: resultLimit,
        thumbWidth: metadataThumbWidth,
        maxlag,
        apiDelayMs,
        pageBatchSize,
        includeUsage,
      })
    : await fetchWikimediaSearchPages({
        query: params.query,
        limit: resultLimit,
        searchOffset,
        thumbWidth: metadataThumbWidth,
        maxlag,
        apiDelayMs,
        includeUsage,
      });

  const artworks: Artwork[] = [];
  const seenTitleKeys = new Set<string>();
  const queuedTitleKeys = new Set<string>();
  const fullDownloadTasks: Array<() => Promise<void>> = [];
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
    skippedPreviewDownload: 0,
    skippedPreviewPending: 0,
    skippedPreviewRejected: 0,
    skippedPreviewApproved: 0,
    skippedMetadata: 0,
    skippedResize: 0,
    previewed: 0,
    previewPending: 0,
    previewApproved: 0,
    previewRejected: 0,
  };

  console.log(
    `Wikimedia full downloads concurrency ${fullDownloadConcurrency}`
  );

  for (const page of pages) {
    const ii = page.imageinfo?.[0];
    if (!ii) {
      stats.skippedNoImageInfo++;
      continue;
    }

    const mime = (ii.mime ?? "").toLowerCase();
    const originalUrl = ii.thumburl ?? ii.url;
    const sourceFileUrl = ii.url;
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
    const existingPreviewDecision = params.existingPreviewDecisions?.get(id);
    if (previewReview && existingPreviewDecision === "pending") {
      stats.skippedPreviewPending++;
      console.log(`Wikimedia preview skipped pending ${page.title}`);
      continue;
    }
    if (existingPreviewDecision === "rejected" && !revisitRejectedPreviews) {
      stats.skippedPreviewRejected++;
      console.log(`Wikimedia preview skipped rejected ${page.title}`);
      continue;
    }
    if (previewReview && existingPreviewDecision === "approved") {
      stats.skippedPreviewApproved++;
      console.log(`Wikimedia preview skipped approved ${page.title}`);
      if (previewOnly) continue;
    }

    const titleKey = normalizeTitleForDedupe(title);
    if (
      !allowDuplicateTitles &&
      titleKey &&
      (seenTitleKeys.has(titleKey) || queuedTitleKeys.has(titleKey))
    ) {
      stats.skippedDuplicateTitle++;
      continue;
    }
    const sourceUrl = pageTitleToUrl(page.title);

    const description =
      ext(meta, "ObjectName") || ext(meta, "ImageDescription") || undefined;

    if (
      !disableCandidateFilters &&
      !looksLikeScreenArt({
        query: params.query,
        title,
        description,
        categories: page.categories,
        mode: artFilterMode,
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
      !disableCandidateFilters &&
      !ignoreUsageFilter &&
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

    if (fullOnly && existingPreviewDecision !== "approved") {
      stats.skippedPreviewPending++;
      console.log(`Wikimedia preview skipped unreviewed ${page.title}`);
      continue;
    }

    if (previewReview && existingPreviewDecision !== "approved") {
      let previewDecision: WikimediaPreviewDecisionRecord;

      try {
        previewDecision = await createWikimediaPreviewDecision({
          id,
          sourceId,
          rawTitle: page.title,
          title,
          query: params.query,
          sourceUrl,
          mime,
          previewUrl: ii.thumburl ?? originalUrl,
          previewWidth,
          imagesRoot: params.imagesRoot,
          license: licenseInfo.license,
          licenseUrl: licenseInfo.licenseUrl,
          artist,
          date,
          description,
          globalUsageCount,
          localUsageCount,
          downloadDelayMs,
        });
      } catch (error) {
        stats.skippedPreviewDownload++;
        console.warn(
          `Wikimedia preview failed for ${page.title}: ${errorMessage(error)}`
        );
        continue;
      }

      stats.previewed++;
      await params.onPreviewDecision?.(previewDecision);
      stats.previewPending++;
      console.log(`Wikimedia preview pending ${page.title}`);
      continue;
    }

    const fullDownloadUrl =
      previewReview && sourceFileUrl ? sourceFileUrl : originalUrl;
    if (titleKey) queuedTitleKeys.add(titleKey);
    console.log(`Wikimedia queued full download ${page.title}`);

    fullDownloadTasks.push(async () => {
      const outDir = path.join(params.imagesRoot, "wikimedia", sourceId);
      await ensureDir(outDir);

      const originalExt = extFromMimeOrUrl(mime, fullDownloadUrl);
      const originalPath = path.join(outDir, `original${originalExt}`);
      const originalPublic = toPublicPath(params.imagesRoot, originalPath);

      try {
        if (await fileExists(originalPath)) {
          console.log(`Wikimedia file ${page.title} already exists locally`);
        } else {
          if (downloadDelayMs > 0) await sleep(downloadDelayMs);
          console.log(`Wikimedia downloading ${page.title}`);
          await downloadToFile(fullDownloadUrl, originalPath, {
            Referer: sourceUrl,
          });
          console.log(`Wikimedia downloaded ${page.title}`);
        }
      } catch (error) {
        stats.skippedDownload++;
        await removeEmptyOutputDir(outDir);
        console.warn(
          `Wikimedia download failed for ${page.title}: ${errorMessage(error)}`
        );
        return;
      }

      const dimensions = await getImageDimensions(originalPath).catch(
        () => undefined
      );
      if (!dimensions) {
        stats.skippedMetadata++;
        await removeOutputDir(outDir);
        console.warn(`Wikimedia metadata failed for ${page.title}`);
        return;
      }

      const resized: Record<string, string> = {};
      const outByWidth: Record<number, string> = {};

      for (const w of params.widths) {
        const p = path.join(outDir, `w${w}.jpg`);
        outByWidth[w] = p;
        resized[String(w)] = toPublicPath(params.imagesRoot, p);
      }

      try {
        console.log(`Wikimedia resizing ${page.title}`);
        await resizeToJpegs({
          inputPath: originalPath,
          outputPathsByWidth: outByWidth,
        });
      } catch (error) {
        stats.skippedResize++;
        await removeOutputDir(outDir);
        console.warn(
          `Wikimedia resize failed for ${page.title}: ${errorMessage(error)}`
        );
        return;
      }

      if (titleKey) seenTitleKeys.add(titleKey);
      stats.accepted++;
      console.log(`Wikimedia accepted ${page.title}`);

      const artwork: Artwork = {
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
          originalUrl: fullDownloadUrl,
          ...dimensions,
          localOriginalPath: originalPublic,
          localResizedPaths: resized,
        },
        search: {
          query: params.query,
          downloadedAt,
        },
      };

      if (params.onArtwork) {
        await params.onArtwork(artwork);
      }

      artworks.push(artwork);
    });
  }

  if (fullDownloadTasks.length > 0) {
    console.log(
      `Wikimedia running ${fullDownloadTasks.length} full downloads with concurrency ${fullDownloadConcurrency}`
    );
    await runLimited(fullDownloadTasks, fullDownloadConcurrency);
  }

  console.log(`Wikimedia scrape stats: ${JSON.stringify(stats)}`);
  return { artworks, stats };
}

async function createWikimediaPreviewDecision(params: {
  id: string;
  sourceId: string;
  rawTitle: string;
  title: string;
  query: string;
  sourceUrl: string;
  mime: string;
  previewUrl: string;
  previewWidth: number;
  imagesRoot: string;
  license: string;
  licenseUrl?: string;
  artist?: string;
  date?: string;
  description?: string;
  globalUsageCount: number;
  localUsageCount: number;
  downloadDelayMs: number;
}): Promise<WikimediaPreviewDecisionRecord> {
  const previewDir = path.join(
    params.imagesRoot,
    "wikimedia-previews",
    params.sourceId
  );
  await ensureDir(previewDir);

  const previewExt = extFromMimeOrUrl(params.mime, params.previewUrl);
  const previewPath = path.join(previewDir, `preview${previewExt}`);
  const requestedAt = new Date().toISOString();

  if (await fileExists(previewPath)) {
    console.log(`Wikimedia preview file ${params.rawTitle} already exists locally`);
  } else {
    if (params.downloadDelayMs > 0) await sleep(params.downloadDelayMs);
    console.log(`Wikimedia preview downloading ${params.rawTitle}`);
    await downloadToFile(params.previewUrl, previewPath, {
      Referer: params.sourceUrl,
    });
  }

  const previewDimensions = await getImageDimensions(previewPath).catch(
    () => undefined
  );

  const pendingPreview = {
    id: params.id,
    sourceId: params.sourceId,
    title: params.title,
    rawTitle: params.rawTitle,
    query: params.query,
    sourceUrl: params.sourceUrl,
    previewUrl: params.previewUrl,
    previewLocalPath: previewPath,
    previewPublicPath: toPublicPath(params.imagesRoot, previewPath),
    previewWidth: params.previewWidth,
    license: params.license,
    licenseUrl: params.licenseUrl,
    artist: params.artist,
    date: params.date,
    description: params.description,
    usage: {
      global: params.globalUsageCount,
      local: params.localUsageCount,
    },
    dimensions: previewDimensions,
    requestedAt,
  };

  console.log(`Wikimedia preview ready ${params.rawTitle}`);

  return {
    id: params.id,
    sourceId: params.sourceId,
    title: params.title,
    query: params.query,
    decision: "pending",
    previewUrl: params.previewUrl,
    previewLocalPath: previewPath,
    sourceUrl: params.sourceUrl,
    decidedAt: requestedAt,
    metadata: {
      rawTitle: params.rawTitle,
      license: params.license,
      licenseUrl: params.licenseUrl,
      artist: params.artist,
      date: params.date,
      description: params.description,
      usage: pendingPreview.usage,
      dimensions: previewDimensions,
      previewWidth: params.previewWidth,
      requestedAt,
    },
  };
}

async function fetchWikimediaSearchPages(params: {
  query: string;
  limit: number;
  searchOffset: number;
  thumbWidth: number;
  maxlag: number;
  apiDelayMs: number;
  includeUsage: boolean;
}) {
  const apiUrl = baseWikimediaPagesUrl({
    thumbWidth: params.thumbWidth,
    maxlag: params.maxlag,
    includeUsage: params.includeUsage,
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
  pageBatchSize: number;
  includeUsage: boolean;
}) {
  const pageIds = await collectWikimediaCategoryFileIds({
    category: params.category,
    depth: params.depth,
    limit: params.limit,
    maxlag: params.maxlag,
    apiDelayMs: params.apiDelayMs,
  });
  const pages: WikimediaPage[] = [];

  const pageIdBatches = chunks(pageIds, params.pageBatchSize);
  let batchIndex = 0;

  for (const batch of pageIdBatches) {
    batchIndex++;
    console.log(
      `Wikimedia metadata batch ${batchIndex}/${pageIdBatches.length} (${batch.length} files)`
    );
    const apiUrl = baseWikimediaPagesUrl({
      thumbWidth: params.thumbWidth,
      maxlag: params.maxlag,
      includeUsage: params.includeUsage,
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

function baseWikimediaPagesUrl(params: {
  thumbWidth: number;
  maxlag: number;
  includeUsage: boolean;
}) {
  const apiUrl = new URL("https://commons.wikimedia.org/w/api.php");
  apiUrl.searchParams.set("action", "query");
  apiUrl.searchParams.set("format", "json");
  apiUrl.searchParams.set("formatversion", "2");
  apiUrl.searchParams.set(
    "prop",
    params.includeUsage
      ? "imageinfo|categories|globalusage|fileusage"
      : "imageinfo|categories"
  );
  apiUrl.searchParams.set("cllimit", "50");
  apiUrl.searchParams.set("clshow", "!hidden");
  apiUrl.searchParams.set("iiprop", "url|mime|size|extmetadata");
  if (params.includeUsage) {
    apiUrl.searchParams.set("gulimit", "200");
    apiUrl.searchParams.set("gunamespace", "*");
    apiUrl.searchParams.set("fulimit", "200");
    apiUrl.searchParams.set("funamespace", "0|6|10|14|100|828");
  }
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

async function fileExists(filePath: string) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function removeOutputDir(dir: string) {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runLimited(tasks: Array<() => Promise<void>>, concurrency: number) {
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, tasks.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < tasks.length) {
        const task = tasks[nextIndex++];
        await task();
      }
    })
  );
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function looksLikeScreenArt(params: {
  query: string;
  title: string;
  description?: string;
  categories: Array<{ title: string }> | undefined;
  mode: WikimediaArtFilterMode;
}) {
  const categoryText = (params.categories ?? []).map((c) => c.title).join(" ");
  const haystack = normalizeForMatch(
    [params.query, params.title, params.description, categoryText]
      .filter(Boolean)
      .join(" ")
  );

  if (params.mode === "broad") return true;

  if (EXCLUDED_NON_ART_HINTS.some((t) => haystack.includes(t))) return false;
  if (INCLUDED_ART_HINTS.some((t) => haystack.includes(t))) return true;
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
