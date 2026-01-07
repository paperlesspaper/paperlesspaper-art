#!/usr/bin/env node

import path from "node:path";
import { Command } from "commander";
import { findWebRoot, parseWidths } from "./paths.js";
import { defaultWebPaths, upsertArtworks } from "./store.js";
import { scrapeMet } from "./sources/met.js";
import { scrapeArtic } from "./sources/artic.js";
import {
  fetchSvgrepoCollectionsPageApiOnly,
  fetchSvgrepoCollectionsPage,
  openSvgrepoSession,
  scrapeSvgrepo,
  scrapeSvgrepoCollectionTerm,
  scrapeSvgrepoCollectionTermApiOnly,
  SvgrepoDownloadBlockedError,
} from "./sources/svgrepo.js";

const program = new Command();

program
  .name("paperlesspaper-scrape")
  .description("Download public-domain artworks + store local metadata")
  .version("0.1.0");

function addCommonOptions(cmd: Command) {
  return cmd
    .requiredOption("-q, --query <string>", "Search query")
    .option("-l, --limit <number>", "Max results", "25")
    .option("-w, --widths <csv>", "Resize widths, e.g. 512,1024", "512,1024")
    .option("--web-root <path>", "Path to apps/web (autodetected if omitted)");
}

addCommonOptions(
  program.command("met").description("Scrape The Met Collection API")
).action(async (opts) => {
  const webRoot = await resolveWebRoot(opts.webRoot);
  const { dataFilePath, imagesRoot } = defaultWebPaths(webRoot);

  const limit = Number(opts.limit);
  const widths = parseWidths(opts.widths);

  const artworks = await scrapeMet({
    query: opts.query,
    limit: Number.isFinite(limit) ? limit : 25,
    widths,
    imagesRoot,
  });

  const result = await upsertArtworks({ dataFilePath, artworks });
  console.log(
    `met: saved ${artworks.length} items (json total ${result.total}) -> ${dataFilePath}`
  );
});

addCommonOptions(
  program.command("artic").description("Scrape Art Institute of Chicago API")
).action(async (opts) => {
  const webRoot = await resolveWebRoot(opts.webRoot);
  const { dataFilePath, imagesRoot } = defaultWebPaths(webRoot);

  const limit = Number(opts.limit);
  const widths = parseWidths(opts.widths);

  const artworks = await scrapeArtic({
    query: opts.query,
    limit: Number.isFinite(limit) ? limit : 25,
    widths,
    imagesRoot,
  });

  const result = await upsertArtworks({ dataFilePath, artworks });
  console.log(
    `artic: saved ${artworks.length} items (json total ${result.total}) -> ${dataFilePath}`
  );
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
    "--cdp-url <url>",
    "Connect to an existing Chrome via CDP (e.g. http://127.0.0.1:9222)",
    ""
  )
  .action(async (opts) => {
    const webRoot = await resolveWebRoot(opts.webRoot);
    const { dataFilePath, imagesRoot } = defaultWebPaths(webRoot);

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
            const artworks = await scrapeSvgrepoCollectionTermApiOnly({
              term: slug,
              limit: perCollectionLimit,
              imagesRoot,
              downloadedAt,
            });

            const result = await upsertArtworks({ dataFilePath, artworks });
            collectionsProcessed++;
            processedSlugs.add(slug);
            console.log(
              `svgrepo: collection ${slug}: saved ${artworks.length} items (json total ${result.total})`
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
          `svgrepo: collections done (processed ${collectionsProcessed}) -> ${dataFilePath}`
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

              const artworks = await scrapeSvgrepoCollectionTerm({
                term: slug,
                limit: perCollectionLimit,
                imagesRoot,
                downloadedAt,
                session,
              });

              const result = await upsertArtworks({ dataFilePath, artworks });
              collectionsProcessed++;
              processedSlugs.add(slug);
              console.log(
                `svgrepo: collection ${slug}: saved ${artworks.length} items (json total ${result.total})`
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
            `svgrepo: collections done (processed ${processedSlugs.size}) -> ${dataFilePath}`
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
      cdpUrl:
        typeof opts.cdpUrl === "string" && opts.cdpUrl.length > 0
          ? opts.cdpUrl
          : undefined,
    });

    const result = await upsertArtworks({ dataFilePath, artworks });
    console.log(
      `svgrepo: saved ${artworks.length} items (json total ${result.total}) -> ${dataFilePath}`
    );
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exitCode = 1;
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
