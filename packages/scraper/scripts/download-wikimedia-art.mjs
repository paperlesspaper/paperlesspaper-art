#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const target = Number(process.env.TARGET ?? 500);
const perSourceCap = Number(process.env.PER_SOURCE_CAP ?? 75);
const categoryLimit = Number(process.env.CATEGORY_LIMIT ?? 800);
const searchLimit = Number(process.env.SEARCH_LIMIT ?? 250);
const concurrency = Number(process.env.CONCURRENCY ?? 8);
const saveEvery = Number(process.env.SAVE_EVERY ?? 50);
const sourceDelay = Number(process.env.SOURCE_DELAY ?? 0);
const thumbnailWidth = Number(process.env.THUMB_WIDTH ?? 4000);
const dataPath = path.resolve("../../apps/web/data/artworks.json");
const imagesRoot = path.resolve("../../apps/web/public/images");
const widths = (process.env.WIDTHS ?? "512,1024")
  .split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value > 0);
const downloadedAt = new Date().toISOString();
const prefix = process.env.SEARCH_PREFIX ?? "wikimedia-art-4000-v1:";

const categories = [
  "Google Art Project works",
  "Paintings in the Google Art Project",
  "Public domain paintings",
  "Public domain drawings",
  "Public domain prints",
  "Oil paintings",
  "Watercolor paintings",
  "Landscape paintings",
  "Still-life paintings",
  "Portrait paintings",
  "Genre paintings",
  "Impressionist paintings",
  "Post-Impressionist paintings",
  "Expressionist paintings",
  "Art Nouveau paintings",
  "Art Deco paintings",
  "Naive art",
  "Ukiyo-e prints",
  "Shin-hanga",
  "Japanese woodblock prints",
  "Katsushika Hokusai",
  "Utagawa Hiroshige",
  "Utagawa Kuniyoshi",
  "Kitagawa Utamaro",
  "Ohara Koson",
  "Kawase Hasui",
  "Paintings by Vincent van Gogh",
  "Paintings by Claude Monet",
  "Paintings by Paul Cezanne",
  "Paintings by Paul Gauguin",
  "Paintings by Henri Rousseau",
  "Paintings by Gustav Klimt",
  "Paintings by Edvard Munch",
  "Paintings by Wassily Kandinsky",
  "Paintings by Piet Mondrian",
  "Paintings by Odilon Redon",
  "Paintings by Pierre-Auguste Renoir",
  "Paintings by Camille Pissarro",
  "Paintings by Mary Cassatt",
  "Paintings by Berthe Morisot",
  "Paintings by Winslow Homer",
  "Paintings by John Singer Sargent",
  "Paintings by William Morris",
  "Paintings by Alphonse Mucha",
  "Works by William Morris",
  "Works by Alphonse Mucha",
  "The Grammar of Ornament",
  "Ornamental designs",
  "Textile patterns",
  "Floral ornaments",
  "Art Nouveau ornaments",
  "Illuminated manuscripts",
  "Book illustrations",
  "Golden Age illustration",
];

const queries = [
  "Wikimedia Commons public domain Google Art Project painting",
  "Wikimedia Commons public domain colorful painting",
  "Wikimedia Commons public domain simple painting",
  "Wikimedia Commons public domain impressionist painting",
  "Wikimedia Commons public domain post impressionist painting",
  "Wikimedia Commons public domain expressionist painting",
  "Wikimedia Commons public domain landscape painting",
  "Wikimedia Commons public domain still life painting",
  "Wikimedia Commons public domain portrait painting",
  "Wikimedia Commons public domain art nouveau painting",
  "Wikimedia Commons public domain decorative art",
  "Wikimedia Commons public domain textile pattern",
  "Wikimedia Commons public domain ornament print",
  "Wikimedia Commons public domain Japanese woodblock print",
  "Wikimedia Commons public domain ukiyo-e print",
  "Wikimedia Commons public domain shin hanga print",
  "Wikimedia Commons public domain Hokusai print",
  "Wikimedia Commons public domain Hiroshige print",
  "Wikimedia Commons public domain Kuniyoshi print",
  "Wikimedia Commons public domain Utamaro print",
  "Wikimedia Commons public domain Ohara Koson print",
  "Wikimedia Commons public domain Kawase Hasui print",
  "Wikimedia Commons public domain Van Gogh painting",
  "Wikimedia Commons public domain Claude Monet painting",
  "Wikimedia Commons public domain Paul Cezanne painting",
  "Wikimedia Commons public domain Gustav Klimt painting",
  "Wikimedia Commons public domain Edvard Munch painting",
  "Wikimedia Commons public domain Wassily Kandinsky painting",
  "Wikimedia Commons public domain Piet Mondrian painting",
  "Wikimedia Commons public domain Henri Rousseau painting",
  "Wikimedia Commons public domain Alphonse Mucha art",
  "Wikimedia Commons public domain William Morris pattern",
  "Wikimedia Commons public domain Golden Age illustration",
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
  skippedNotArt: 0,
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
    const pages = await categoryMembers(category, categoryLimit);
    added = await processPages({
      pages,
      label: `Category:${category}`,
      catalogQuery: `category:${category}`,
    });
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

  const originalUrl = ii.thumburl || ii.url;
  if (!originalUrl || !allowedRaster(ii.mime || "", originalUrl)) {
    stats.skippedType++;
    return false;
  }

  const meta = ii.extmetadata || {};
  const license = classifyLicense(
    ext(meta, "LicenseShortName"),
    ext(meta, "LicenseUrl"),
    ext(meta, "UsageTerms")
  );
  if (!license) {
    stats.skippedLicense++;
    return false;
  }

  const title = displayTitle(page.title);
  if (!looksLikeArt({ title, meta, categories: page.categories })) {
    stats.skippedNotArt++;
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
    tags: [...pageCategories, "wikimedia art batch"],
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
    .replace(/lccn\d+/g, "")
    .replace(/\b(file|crop|copy|google art project|wikimedia commons)\b/g, " ")
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

function looksLikeArt({ title, meta, categories }) {
  const text = [
    title,
    ext(meta, "ObjectName"),
    ext(meta, "ImageDescription"),
    ...(categories || []).map((category) => category.title),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (
    /logo|map|diagram|chart|screenshot|interface|flag|coat of arms|heraldry|currency|coin|stamp|building exterior|building interior/.test(
      text
    )
  ) {
    return false;
  }

  return /art|painting|paintings|watercolor|oil on canvas|drawing|drawings|print|prints|woodblock|ukiyo|shin-hanga|illustration|ornament|pattern|textile|landscape|portrait|still life|impressionist|expressionist|google art project|museum|gallery|mucha|hokusai|hiroshige|kuniyoshi|utamaro|koson|hasui|van gogh|monet|cezanne|gauguin|klimt|munch|kandinsky|mondrian|rousseau|redon|renoir|pissarro|cassatt|morisot|homer|sargent/.test(
    text
  );
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
    const apiUrl = baseApiUrl();
    apiUrl.searchParams.set("generator", "categorymembers");
    apiUrl.searchParams.set(
      "gcmtitle",
      category.startsWith("Category:") ? category : `Category:${category}`
    );
    apiUrl.searchParams.set("gcmnamespace", "6");
    apiUrl.searchParams.set("gcmtype", "file");
    apiUrl.searchParams.set("gcmlimit", String(Math.min(50, limit - pages.length)));

    if (continuation) {
      for (const [key, value] of Object.entries(continuation)) {
        apiUrl.searchParams.set(key, value);
      }
    }

    const json = await fetchJsonWithRetry(apiUrl, "category");
    pages.push(...(json.query?.pages || []));

    if (!json.continue) break;
    continuation = json.continue;
  }

  return pages;
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
