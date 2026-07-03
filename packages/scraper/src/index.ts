#!/usr/bin/env node

import path from "node:path";
import { Command } from "commander";
import { findWebRoot, parseWidths } from "./paths.js";
import {
  closeArtworkStore,
  defaultWebPaths,
  loadExistingArtworkIds,
  loadWikimediaPreviewDecisions,
  loadWikimediaPreviewDecisionRatings,
  setArtworkCurationRating,
  upsertArtwork,
  upsertArtworks,
  upsertWikimediaPreviewDecision,
} from "./store.js";
import { scrapeMet } from "./sources/met.js";
import { scrapeArtic } from "./sources/artic.js";
import { scrapeWikimedia } from "./sources/wikimedia.js";
import {
  fetchSvgrepoCollectionsPageApiOnly,
  fetchSvgrepoCollectionsPage,
  openSvgrepoSession,
  scrapeSvgrepo,
  scrapeSvgrepoCollectionTerm,
  scrapeSvgrepoCollectionTermApiOnly,
  SvgrepoDownloadBlockedError,
  isUsableSvgrepoLicense,
} from "./sources/svgrepo.js";

const program = new Command();

program
  .name("paperlesspaper-scrape")
  .description("Download public-domain artworks + upsert catalog metadata")
  .version("0.1.0");

function addCommonOptions(cmd: Command) {
  return cmd
    .requiredOption("-q, --query <string>", "Search query")
    .option("-l, --limit <number>", "Max results", "25")
    .option("-w, --widths <csv>", "Resize widths, e.g. 512,1024", "512,1024")
    .option("--web-root <path>", "Path to apps/web (autodetected if omitted)")
    .option(
      "--refresh-existing",
      "Refresh artwork IDs that already exist in Postgres instead of skipping them"
    );
}

addCommonOptions(
  program.command("met").description("Scrape The Met Collection API")
).action(async (opts) => {
  const webRoot = await resolveWebRoot(opts.webRoot);
  const { imagesRoot } = defaultWebPaths(webRoot);

  const limit = Number(opts.limit);
  const widths = parseWidths(opts.widths);
  const existingArtworkIds = await resolveExistingArtworkIds(opts.refreshExisting);

  const artworks = await scrapeMet({
    query: opts.query,
    limit: Number.isFinite(limit) ? limit : 25,
    widths,
    imagesRoot,
    existingArtworkIds,
  });

  const result = await upsertArtworks({ artworks });
  console.log(formatUpsertSummary("met", result));
});

addCommonOptions(
  program.command("artic").description("Scrape Art Institute of Chicago API")
).action(async (opts) => {
  const webRoot = await resolveWebRoot(opts.webRoot);
  const { imagesRoot } = defaultWebPaths(webRoot);

  const limit = Number(opts.limit);
  const widths = parseWidths(opts.widths);
  const existingArtworkIds = await resolveExistingArtworkIds(opts.refreshExisting);

  const artworks = await scrapeArtic({
    query: opts.query,
    limit: Number.isFinite(limit) ? limit : 25,
    widths,
    imagesRoot,
    existingArtworkIds,
  });

  const result = await upsertArtworks({ artworks });
  console.log(formatUpsertSummary("artic", result));
});

addCommonOptions(
  program
    .command("wikimedia")
    .description("Scrape Wikimedia Commons (CC/PD-licensed raster images)")
    .option(
      "--min-global-usage <number>",
      "Minimum global Wikimedia usage count",
      "0"
    )
    .option(
      "--min-local-usage <number>",
      "Minimum local Commons usage count",
      "0"
    )
    .option(
      "--thumb-width <number>",
      "Wikimedia thumbnail width to request",
      "1024"
    )
    .option(
      "--allow-duplicate-titles",
      "Do not skip files whose normalized titles match an earlier accepted item"
    )
    .option(
      "--revisit-rejected-previews",
      "Show previews again even if they were rejected before"
    )
    .option(
      "--ignore-usage-filter",
      "Do not skip files because of Wikimedia usage/category thresholds"
    )
    .option(
      "--disable-candidate-filters",
      "Do not skip candidates because of art/usage filters"
    )
    .option(
      "--art-filter <mode>",
      "Art heuristic mode: broad or strict",
      "broad"
    )
    .option(
      "--review-mode <mode>",
      "Preview review mode: both, previews, or full",
      "both"
    )
    .option(
      "--full-download-concurrency <number>",
      "Number of full-size Wikimedia downloads to run in parallel",
      "3"
    )
    .option(
      "--preview-review",
      "Download a small preview and wait for an approved/rejected decision before the full download"
    )
    .option(
      "--preview-width <number>",
      "Wikimedia preview thumbnail width to request when --preview-review is enabled",
      "160"
    )
    .option(
      "--preview-review-dir <path>",
      "Directory used for preview review handoff files",
      ".wikimedia-preview-review"
    )
    .option(
      "--download-delay-ms <number>",
      "Delay between Wikimedia image downloads",
      "1000"
    )
    .option(
      "--search-offset <number>",
      "Wikimedia search offset for pagination",
      "0"
    )
    .option(
      "--category <title>",
      "Wikimedia Commons category to recurse, e.g. 'Category:Works by Ernst Ludwig Kirchner'"
    )
    .option(
      "--category-depth <number>",
      "Maximum subcategory recursion depth when --category is used",
      "5"
    )
).action(async (opts) => {
  const webRoot = await resolveWebRoot(opts.webRoot);
  const { imagesRoot } = defaultWebPaths(webRoot);

  const limit = Number(opts.limit);
  const widths = parseWidths(opts.widths);
  const minGlobalUsage = parseNonNegativeInt(opts.minGlobalUsage, 0);
  const minLocalUsage = parseNonNegativeInt(opts.minLocalUsage, 0);
  const thumbWidth = parseNonNegativeInt(opts.thumbWidth, 1024);
  const fullDownloadConcurrency = Math.min(
    8,
    Math.max(1, parseNonNegativeInt(opts.fullDownloadConcurrency, 3))
  );
  const previewWidth = parseNonNegativeInt(opts.previewWidth, 160);
  const downloadDelayMs = parseNonNegativeInt(opts.downloadDelayMs, 1000);
  const searchOffset = parseNonNegativeInt(opts.searchOffset, 0);
  const categoryDepth = parseNonNegativeInt(opts.categoryDepth, 5);
  const existingArtworkIds = await resolveExistingArtworkIds(opts.refreshExisting);
  const existingPreviewDecisions = await loadWikimediaPreviewDecisions();
  const previewDecisionRatings = await loadWikimediaPreviewDecisionRatings();

  const totalResult = {
    inserted: 0,
    updated: 0,
    addedOrUpdated: 0,
  };

  const { stats } = await scrapeWikimedia({
    query: opts.query,
    limit: Number.isFinite(limit) ? limit : 25,
    widths,
    imagesRoot,
    minGlobalUsage,
    minLocalUsage,
    thumbWidth,
    allowDuplicateTitles: opts.allowDuplicateTitles === true,
    revisitRejectedPreviews: opts.revisitRejectedPreviews === true,
    disableCandidateFilters: opts.disableCandidateFilters === true,
    ignoreUsageFilter: opts.ignoreUsageFilter === true,
    artFilterMode: opts.artFilter === "strict" ? "strict" : "broad",
    reviewMode:
      opts.reviewMode === "previews" || opts.reviewMode === "full"
        ? opts.reviewMode
        : "both",
    fullDownloadConcurrency,
    previewReview: opts.previewReview === true,
    previewWidth,
    downloadDelayMs,
    searchOffset,
    category: opts.category,
    categoryDepth,
    existingArtworkIds,
    existingPreviewDecisions,
    onArtwork: async (artwork) => {
      console.log(`Wikimedia upserting ${artwork.title}`);
      const result = await upsertArtwork(artwork);
      totalResult.inserted += result.inserted;
      totalResult.updated += result.updated;
      totalResult.addedOrUpdated += result.addedOrUpdated;
      console.log(formatUpsertSummary("wikimedia", result));
      const rating = previewDecisionRatings.get(artwork.id);
      if (rating) {
        await setArtworkCurationRating(artwork.id, rating);
        console.log(`Wikimedia rated ${artwork.title} ${rating}`);
      }
      console.log(`Wikimedia upserted ${artwork.title}`);
    },
    onPreviewDecision: async (decision) => {
      await upsertWikimediaPreviewDecision(decision);
    },
  });

  console.log(formatUpsertSummary("wikimedia total", totalResult));
  if (
    opts.previewReview === true &&
    (stats.previewPending > 0 || stats.skippedPreviewPending > 0)
  ) {
    process.exitCode = 75;
  }
});

program
  .command("svgrepo")
  .description("Scrape Svgrepo SVG icons (stores SVGs, no resizing)")
  .option("-q, --query <string>", "Search query")
  .option(
    "--collection-url <url>",
    "Svgrepo collection URL (e.g. https://www.svgrepo.com/collection/.../)"
  )
  .option(
    "--all-collections",
    "Download all collections via https://api.svgrepo.com/collections (fixed limit=12)"
  )
  .option(
    "--collections-start <number>",
    "Start offset for the collections API (resume support)",
    "0"
  )
  .option(
    "--per-collection-limit <number>",
    "Max icons to download per collection (omit to download all)"
  )
  .option(
    "--api-only",
    "Use only api.svgrepo.com endpoints + direct SVG downloads (no Playwright/browser)"
  )
  .option(
    "--api-prefer",
    "Try API-only first; if downloads are blocked (429/403), fall back to browser/Playwright"
  )
  .option("-l, --limit <number>", "Max results")
  .option("--web-root <path>", "Path to apps/web (autodetected if omitted)")
  .option(
    "--refresh-existing",
    "Refresh artwork IDs that already exist in Postgres instead of skipping them"
  )
  .option(
    "--cdp-url <url>",
    "Connect to an existing Chrome via CDP (e.g. http://127.0.0.1:9222)",
    ""
  )
  .action(async (opts) => {
    const webRoot = await resolveWebRoot(opts.webRoot);
    const { imagesRoot } = defaultWebPaths(webRoot);
    const existingArtworkIds = await resolveExistingArtworkIds(
      opts.refreshExisting
    );

    if (opts.allCollections) {
      const collectionsStart = Number(opts.collectionsStart);
      if (!Number.isFinite(collectionsStart) || collectionsStart < 0) {
        throw new Error("svgrepo: --collections-start must be a number >= 0");
      }

      const perCollectionLimitRaw =
        typeof opts.perCollectionLimit === "string" &&
        opts.perCollectionLimit.length > 0
          ? Number(opts.perCollectionLimit)
          : undefined;
      const perCollectionLimit =
        perCollectionLimitRaw &&
        Number.isFinite(perCollectionLimitRaw) &&
        perCollectionLimitRaw > 0
          ? perCollectionLimitRaw
          : Number.POSITIVE_INFINITY;

      const downloadedAt = new Date().toISOString();

      const processedSlugs = new Set<string>();

      const runApiOnly = async () => {
        let start = collectionsStart;
        let totalCount: number | null = null;
        let collectionsProcessed = 0;

        while (true) {
          const page = await fetchSvgrepoCollectionsPageApiOnly({ start });
          if (totalCount === null) totalCount = page.totalCount;

          if (page.slugs.length === 0) break;

          for (const slug of page.slugs) {
            const collection = page.collections.find((item) => item.slug === slug);
            if (
              collection &&
              !isUsableSvgrepoLicense(
                collection.license,
                collection.licenseLink
              )
            ) {
              collectionsProcessed++;
              processedSlugs.add(slug);
              console.log(
                `svgrepo: collection ${slug}: skipped license ${collection.license || "unknown"}`
              );
              continue;
            }

            const artworks = await scrapeSvgrepoCollectionTermApiOnly({
              term: slug,
              limit: perCollectionLimit,
              imagesRoot,
              downloadedAt,
              existingArtworkIds,
            });

            const result = await upsertArtworks({ artworks });
            collectionsProcessed++;
            processedSlugs.add(slug);
            console.log(
              formatUpsertSummary(`svgrepo: collection ${slug}`, result)
            );
          }

          start += page.slugs.length;
          if (totalCount !== null && start >= totalCount) break;

          console.log(
            `svgrepo: collections progress ${start}/${
              totalCount ?? "?"
            } (processed ${collectionsProcessed})`
          );
        }

        console.log(
          `svgrepo: collections done (processed ${collectionsProcessed})`
        );

        return { processed: collectionsProcessed };
      };

      const runBrowser = async () => {
        const session = await openSvgrepoSession({
          cdpUrl:
            typeof opts.cdpUrl === "string" && opts.cdpUrl.length > 0
              ? opts.cdpUrl
              : undefined,
          urlToVisit: "https://www.svgrepo.com/",
        });

        try {
          let start = collectionsStart;
          let totalCount: number | null = null;
          let collectionsProcessed = 0;

          while (true) {
            const page = await fetchSvgrepoCollectionsPage({
              requestContext: session.requestContext,
              start,
            });
            if (totalCount === null) totalCount = page.totalCount;

            if (page.slugs.length === 0) break;

            for (const slug of page.slugs) {
              if (processedSlugs.has(slug)) continue;
              const collection = page.collections.find((item) => item.slug === slug);
              if (
                collection &&
                !isUsableSvgrepoLicense(
                  collection.license,
                  collection.licenseLink
                )
              ) {
                processedSlugs.add(slug);
                console.log(
                  `svgrepo: collection ${slug}: skipped license ${collection.license || "unknown"}`
                );
                continue;
              }

              const artworks = await scrapeSvgrepoCollectionTerm({
                term: slug,
                limit: perCollectionLimit,
                imagesRoot,
                downloadedAt,
                session,
                existingArtworkIds,
              });

              const result = await upsertArtworks({ artworks });
              collectionsProcessed++;
              processedSlugs.add(slug);
              console.log(
                formatUpsertSummary(`svgrepo: collection ${slug}`, result)
              );
            }

            start += page.slugs.length;
            if (totalCount !== null && start >= totalCount) break;

            console.log(
              `svgrepo: collections progress ${start}/${
                totalCount ?? "?"
              } (processed ${processedSlugs.size})`
            );
          }

          console.log(
            `svgrepo: collections done (processed ${processedSlugs.size})`
          );
        } finally {
          await session.close();
        }
      };

      if (opts.apiOnly) {
        await runApiOnly();
        return;
      }

      if (opts.apiPrefer) {
        try {
          await runApiOnly();
          return;
        } catch (err) {
          if (err instanceof SvgrepoDownloadBlockedError) {
            console.warn(
              `${err.message}\nsvgrepo: switching to browser/Playwright fallback...`
            );
            await runBrowser();
            return;
          }
          throw err;
        }
      }

      await runBrowser();

      return;
    }

    const parsedLimit =
      typeof opts.limit === "string" && opts.limit.length > 0
        ? Number(opts.limit)
        : undefined;
    const limit =
      parsedLimit && Number.isFinite(parsedLimit) && parsedLimit > 0
        ? parsedLimit
        : opts.collectionUrl
        ? Number.POSITIVE_INFINITY
        : 25;

    if (!opts.query && !opts.collectionUrl) {
      throw new Error("svgrepo: pass either --query or --collection-url");
    }

    const artworks = await scrapeSvgrepo({
      query: opts.query ?? "",
      collectionUrl:
        typeof opts.collectionUrl === "string" && opts.collectionUrl.length > 0
          ? opts.collectionUrl
          : undefined,
      limit,
      imagesRoot,
      existingArtworkIds,
      cdpUrl:
        typeof opts.cdpUrl === "string" && opts.cdpUrl.length > 0
          ? opts.cdpUrl
          : undefined,
    });

    const result = await upsertArtworks({ artworks });
    console.log(formatUpsertSummary("svgrepo", result));
  });

program
  .parseAsync(process.argv)
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeArtworkStore().catch(() => undefined);
  });

async function resolveWebRoot(flagValue?: string) {
  if (flagValue) return path.resolve(flagValue);

  const detected = await findWebRoot(process.cwd());
  if (!detected) {
    throw new Error(
      "Could not autodetect apps/web. Pass --web-root /absolute/path/to/apps/web"
    );
  }
  return detected;
}

function parseNonNegativeInt(value: unknown, fallback: number) {
  const parsed =
    typeof value === "string" && value.trim().length > 0
      ? Number(value)
      : value;

  if (
    typeof parsed !== "number" ||
    !Number.isFinite(parsed) ||
    parsed < 0
  ) {
    return fallback;
  }

  return Math.trunc(parsed);
}

async function resolveExistingArtworkIds(refreshExisting?: boolean) {
  return refreshExisting ? undefined : await loadExistingArtworkIds();
}

function formatUpsertSummary(
  label: string,
  result: { inserted: number; updated: number; addedOrUpdated: number }
) {
  return `${label}: upserted ${result.addedOrUpdated} items into Postgres (${result.inserted} inserted, ${result.updated} updated)`;
}
