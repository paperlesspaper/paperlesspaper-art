#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const target = Number(process.env.TARGET ?? 1000);
const perSourceCap = Number(process.env.PER_SOURCE_CAP ?? target);
const categoryLimit = Number(process.env.CATEGORY_LIMIT ?? 50000);
const searchLimit = Number(process.env.SEARCH_LIMIT ?? 500);
const concurrency = Number(process.env.CONCURRENCY ?? 10);
const saveEvery = Number(process.env.SAVE_EVERY ?? 100);
const sourceDelay = Number(process.env.SOURCE_DELAY ?? 0);
const thumbnailWidth = Number(process.env.THUMB_WIDTH ?? 3840);
const dataPath = path.resolve("../../apps/web/data/artworks.json");
const imagesRoot = path.resolve("../../apps/web/public/images");
const widths = (process.env.WIDTHS ?? "")
  .split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value > 0);
const downloadedAt = new Date().toISOString();
const prefix = process.env.SEARCH_PREFIX ?? "google-art-project-3840-v1:";

const categories = [
  "Google Art Project paintings",
  "Google Art Project",
  "Gigapixel images from the Google Art Project",
  "Google Art Project works in Harvard Art Museums",
  "Google Art Project works in Art Gallery of Ontario",
  "Google Art Project works in National Museum in Warsaw",
  "Google Art Project works in the Österreichische Galerie Belvedere",
  "Google Art Project works in Calouste Gulbenkian Museum",
  "Google Art Project works in Art Gallery of South Australia",
  "Google Art Project works in Staatliche Kunsthalle Karlsruhe",
];

const queries = [
  '"Google Art Project" filetype:bitmap',
  '"Google Art Project" painting',
  '"Google Art Project" artwork',
  '"Google Cultural Institute" painting',
  '"Google Cultural Institute" artwork',
];

const artworks = JSON.parse(await fs.readFile(dataPath, "utf8"));
const byId = new Set(artworks.map((artwork) => artwork.id));
const titleKeys = new Set(
  artworks
    .filter((artwork) => artwork.source !== "svgrepo")
    .map((artwork) => titleKey(artwork.title))
    .filter(Boolean)
);
const sha1s = new Set(
  artworks
    .map((artwork) => artwork.image?.wikimediaSha1 || artwork.image?.sha1)
    .filter(Boolean)
);

console.log(
  `duplicate index: ${byId.size} ids, ${titleKeys.size} titles, ${sha1s.size} sha1s`
);

const stats = {
  added: 0,
  total: artworks.length,
  candidates: 0,
  skippedExisting: 0,
  skippedSha1Dup: 0,
  skippedLicense: 0,
  skippedType: 0,
  skippedNotGoogleArtProject: 0,
  skippedTitleDup: 0,
  skippedOutput: 0,
  skippedDownload: 0,
};
let lastSavedAdded = 0;
let saveQueue = Promise.resolve();

for (const category of categories) {
  if (stats.added >= target) break;

  let added = 0;
  try {
    added = await processCategory(category);
  } catch (error) {
    console.warn(`category failed: ${category}: ${errorMessage(error)}`);
  }

  await saveCatalog();
  console.log(
    `category done: ${category} -> +${added}, total ${stats.added}/${target}`
  );
  if (sourceDelay > 0) await sleep(sourceDelay);
}

for (const query of queries) {
  if (stats.added >= target) break;

  let added = 0;
  try {
    const pages = await search(query, searchLimit);
    added = await processPages({
      pages,
      label: query,
      catalogQuery: `search:${query}`,
    });
  } catch (error) {
    console.warn(`query failed: ${query}: ${errorMessage(error)}`);
  }

  await saveCatalog();
  console.log(`query done: ${query} -> +${added}, total ${stats.added}/${target}`);
  if (sourceDelay > 0) await sleep(sourceDelay);
}

await saveCatalog();
console.log(JSON.stringify({ ...stats, total: artworks.length }, null, 2));

if (process.env.STOP_ON_EMPTY === "1" && stats.added === 0) {
  process.exitCode = 20;
}

async function processPages({ pages, label, catalogQuery }) {
  let cursor = 0;
  let added = 0;

  const workerCount = Math.min(concurrency, pages.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (stats.added < target && added < perSourceCap) {
        const page = pages[cursor++];
        if (!page) break;

        const didAdd = await processPage({ page, label, catalogQuery });
        if (didAdd) added++;
      }
    })
  );

  return added;
}

async function processCategory(category) {
  let added = 0;
  let seen = 0;
  let continuation = undefined;
  const label = `Category:${category}`;
  const catalogQuery = `category:${category}`;

  while (stats.added < target && added < perSourceCap && seen < categoryLimit) {
    const { pages, continuation: nextContinuation } = await categoryMembersPage({
      category,
      limit: Math.min(50, categoryLimit - seen),
      continuation,
    });

    seen += pages.length;
    if (pages.length === 0) break;

    added += await processPages({ pages, label, catalogQuery });
    await saveCatalog();

    if (!nextContinuation) break;
    continuation = nextContinuation;
  }

  return added;
}

async function processPage({ page, label, catalogQuery }) {
  stats.candidates++;

  const ii = page.imageinfo?.[0];
  if (!ii) return false;

  const sourceId = String(page.pageid);
  const id = `wikimedia:${sourceId}`;
  if (byId.has(id)) {
    stats.skippedExisting++;
    return false;
  }

  if (ii.sha1 && sha1s.has(ii.sha1)) {
    stats.skippedSha1Dup++;
    return false;
  }

  const meta = ii.extmetadata || {};
  const title = displayTitle(page.title);
  if (!isGoogleArtProject({ title, meta, categories: page.categories })) {
    stats.skippedNotGoogleArtProject++;
    return false;
  }

  const originalUrl = thumbnailUrl(ii.thumburl || ii.url, thumbnailWidth);
  if (!originalUrl || !allowedRaster(ii.mime || "", originalUrl)) {
    stats.skippedType++;
    return false;
  }

  const license = classifyLicense(
    ext(meta, "LicenseShortName"),
    ext(meta, "LicenseUrl"),
    ext(meta, "UsageTerms")
  );
  if (!license) {
    stats.skippedLicense++;
    return false;
  }

  const key = titleKey(title);
  if (key && titleKeys.has(key)) {
    stats.skippedTitleDup++;
    return false;
  }

  byId.add(id);
  if (key) titleKeys.add(key);
  if (ii.sha1) sha1s.add(ii.sha1);

  let buffer;
  try {
    const response = await fetch(originalUrl, {
      headers: { Referer: sourceUrl(page.title) },
    });
    if (!response.ok) throw new Error(String(response.status));
    buffer = Buffer.from(await response.arrayBuffer());
  } catch {
    stats.skippedDownload++;
    return false;
  }

  let metadata;
  try {
    metadata = await sharp(buffer).metadata();
    if (!metadata.width || !metadata.height) throw new Error("missing size");
  } catch {
    stats.skippedDownload++;
    return false;
  }

  const extension = extFromMimeOrUrl(ii.mime || "", originalUrl);
  const outputDir = path.join(imagesRoot, "wikimedia", sourceId);
  const resized = {};

  try {
    await fs.mkdir(outputDir, { recursive: true });

    const originalPath = path.join(outputDir, `original${extension}`);
    await fs.writeFile(originalPath, buffer);

    await Promise.all(
      widths.map(async (width) => {
        const outputPath = path.join(outputDir, `w${width}.jpg`);
        await sharp(buffer)
          .rotate()
          .resize({ width, withoutEnlargement: true })
          .jpeg({ quality: 82, mozjpeg: true })
          .toFile(outputPath);
        resized[String(width)] = `/images/wikimedia/${sourceId}/w${width}.jpg`;
      })
    );
  } catch (error) {
    stats.skippedOutput++;
    console.warn(`output failed: ${title}: ${errorMessage(error)}`);
    await fs.rm(outputDir, { recursive: true, force: true }).catch(() => {});
    return false;
  }

  const pageCategories = (page.categories || [])
    .map((category) =>
      category.title.replace(/^Category:/, "").replace(/_/g, " ").trim()
    )
    .filter(Boolean)
    .slice(0, 25);

  artworks.unshift({
    id,
    source: "wikimedia",
    sourceId,
    title,
    description:
      ext(meta, "ObjectName") || ext(meta, "ImageDescription") || undefined,
    artist: ext(meta, "Artist") || undefined,
    date:
      ext(meta, "DateTimeOriginal") ||
      ext(meta, "DateTime") ||
      ext(meta, "Date") ||
      undefined,
    isPublicDomain: license.isPublicDomain,
    license: license.license,
    licenseUrl: license.licenseUrl,
    rights: ext(meta, "Credit") || undefined,
    sourceUrl: sourceUrl(page.title),
    tags: [...pageCategories, "google art project batch"],
    image: {
      originalUrl,
      width: metadata.width,
      height: metadata.height,
      wikimediaSha1: ii.sha1 || undefined,
      localOriginalPath: `/images/wikimedia/${sourceId}/original${extension}`,
      localResizedPaths: resized,
    },
    search: {
      query: prefix + catalogQuery,
      downloadedAt,
    },
  });

  stats.added++;
  stats.total = artworks.length;
  await maybeSaveCatalog();

  console.log(
    `added ${stats.added}/${target}: ${title} (${metadata.width}x${metadata.height}) from ${label}`
  );

  return true;
}

async function saveCatalog() {
  const tempPath = `${dataPath}.tmp-${process.pid}`;
  await fs.writeFile(tempPath, `${JSON.stringify(artworks, null, 2)}\n`);
  await fs.rename(tempPath, dataPath);
}

async function maybeSaveCatalog() {
  if (stats.added - lastSavedAdded < saveEvery) return;
  const addedAtSave = stats.added;
  saveQueue = saveQueue.then(async () => {
    await saveCatalog();
    lastSavedAdded = Math.max(lastSavedAdded, addedAtSave);
  });
  await saveQueue;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function ext(metadata, key) {
  const raw = metadata?.[key]?.value;
  if (typeof raw !== "string") return undefined;
  return raw.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim() || undefined;
}

function titleKey(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\b(file|crop|copy|google art project|google cultural institute)\b/g, " ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function displayTitle(title) {
  return title
    .replace(/^File:/, "")
    .replace(/_/g, " ")
    .replace(/\.[a-z0-9]{2,5}$/i, "");
}

function sourceUrl(title) {
  return `https://commons.wikimedia.org/wiki/${encodeURIComponent(
    title.replace(/ /g, "_")
  )}`;
}

function thumbnailUrl(url, width) {
  if (!url) return undefined;

  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/");
    const thumbIndex = parts.indexOf("thumb");

    if (thumbIndex >= 0 && parts.length > thumbIndex + 4) {
      const fileName = parts.at(-2);
      parts[parts.length - 1] = `${width}px-${fileName}`;
      parsed.pathname = parts.join("/");
      parsed.search = "";
      return parsed.toString();
    }

    const commonsIndex = parts.indexOf("commons");
    if (commonsIndex >= 0 && parts.length > commonsIndex + 3) {
      const prefix = parts.slice(0, commonsIndex + 1);
      const hashParts = parts.slice(commonsIndex + 1, -1);
      const fileName = parts.at(-1);
      parsed.pathname = [
        ...prefix,
        "thumb",
        ...hashParts,
        fileName,
        `${width}px-${fileName}`,
      ].join("/");
      parsed.search = "";
      return parsed.toString();
    }
  } catch {
    // Fall through to the API URL if it cannot be normalized.
  }

  return url;
}

function isGoogleArtProject({ title, meta, categories }) {
  const text = [
    title,
    ext(meta, "Credit"),
    ext(meta, "Artist"),
    ext(meta, "ObjectName"),
    ext(meta, "ImageDescription"),
    ...(categories || []).map((category) => category.title),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return /google art project|google cultural institute|google arts/.test(text);
}

function allowedRaster(mime, url) {
  const normalized = mime.toLowerCase();
  if (normalized.includes("svg") || normalized === "image/gif") return false;
  if (normalized.startsWith("image/")) return true;

  try {
    return [".jpg", ".jpeg", ".png", ".webp"].includes(
      path.extname(new URL(url).pathname).toLowerCase()
    );
  } catch {
    return false;
  }
}

function extFromMimeOrUrl(mime, url) {
  const normalized = mime.toLowerCase();
  if (normalized === "image/jpeg") return ".jpg";
  if (normalized === "image/png") return ".png";
  if (normalized === "image/webp") return ".webp";

  try {
    const extension = path.extname(new URL(url).pathname);
    if (extension && extension.length <= 6) return extension;
  } catch {
    // Fall through.
  }

  return ".jpg";
}

function classifyLicense(shortName, url, terms) {
  const text = [shortName, url, terms].filter(Boolean).join(" ").toLowerCase();
  if (!text) return null;
  if (
    /noncommercial|non-commercial|\bnc\b|no derivatives|no-derivatives|\bnd\b|fair use|copyrighted|all rights reserved/.test(
      text
    )
  ) {
    return null;
  }

  const isPublicDomain = /public domain|pd-|cc0|pdm|no known copyright/.test(
    text
  );
  const isFree =
    isPublicDomain ||
    /cc-by|creative commons attribution|cc by|cc-by-sa|cc by-sa/.test(text);
  if (!isFree) return null;

  return {
    license: shortName || terms || "Free license",
    licenseUrl: url,
    isPublicDomain,
  };
}

async function search(query, limit) {
  const apiUrl = baseApiUrl();
  apiUrl.searchParams.set("generator", "search");
  apiUrl.searchParams.set("gsrnamespace", "6");
  apiUrl.searchParams.set("gsrlimit", String(limit));
  apiUrl.searchParams.set("gsrsearch", query);

  const json = await fetchJsonWithRetry(apiUrl, "search");
  return json.query?.pages || [];
}

async function categoryMembers(category, limit) {
  const pages = [];
  let continuation = undefined;

  while (pages.length < limit) {
    const result = await categoryMembersPage({
      category,
      limit: Math.min(50, limit - pages.length),
      continuation,
    });
    pages.push(...result.pages);

    if (!result.continuation) break;
    continuation = result.continuation;
  }

  return pages;
}

async function categoryMembersPage({ category, limit, continuation }) {
  const apiUrl = baseApiUrl();
  apiUrl.searchParams.set("generator", "categorymembers");
  apiUrl.searchParams.set(
    "gcmtitle",
    category.startsWith("Category:") ? category : `Category:${category}`
  );
  apiUrl.searchParams.set("gcmnamespace", "6");
  apiUrl.searchParams.set("gcmtype", "file");
  apiUrl.searchParams.set("gcmlimit", String(limit));

  if (continuation) {
    for (const [key, value] of Object.entries(continuation)) {
      apiUrl.searchParams.set(key, value);
    }
  }

  const json = await fetchJsonWithRetry(apiUrl, "category");
  return {
    pages: json.query?.pages || [],
    continuation: json.continue,
  };
}

function baseApiUrl() {
  const apiUrl = new URL("https://commons.wikimedia.org/w/api.php");
  apiUrl.searchParams.set("action", "query");
  apiUrl.searchParams.set("format", "json");
  apiUrl.searchParams.set("formatversion", "2");
  apiUrl.searchParams.set("prop", "imageinfo|categories");
  apiUrl.searchParams.set("cllimit", "50");
  apiUrl.searchParams.set("clshow", "!hidden");
  apiUrl.searchParams.set("iiprop", "url|mime|size|sha1|extmetadata");
  apiUrl.searchParams.set("iiurlwidth", String(thumbnailWidth));
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

async function fetchJsonWithRetry(apiUrl, label) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetch(apiUrl);
    if (response.ok) return response.json();

    if (response.status !== 429 || attempt === 3) {
      throw new Error(`${label} failed ${response.status}`);
    }

    const retryAfter = Number(response.headers.get("retry-after"));
    const waitMs =
      Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : (attempt + 1) * 15000;
    console.log(`${label} 429; waiting ${Math.round(waitMs / 1000)}s`);
    await sleep(waitMs);
  }

  return {};
}
