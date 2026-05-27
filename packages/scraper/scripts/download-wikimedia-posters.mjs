#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const target = Number(process.env.TARGET ?? 200);
const perQueryCap = Number(process.env.PER_QUERY_CAP ?? 18);
const dataPath = path.resolve("../../apps/web/data/artworks.json");
const imagesRoot = path.resolve("../../apps/web/public/images");
const widths = [512, 1024];
const downloadedAt = new Date().toISOString();
const prefix = process.env.SEARCH_PREFIX ?? "poster-more-4000-v2:";

const queries = [
  "Wikimedia Commons public domain WPA poster art",
  "Wikimedia Commons public domain Federal Art Project poster",
  "Wikimedia Commons public domain Federal Theatre Project poster",
  "Wikimedia Commons public domain Federal Music Project poster",
  "Wikimedia Commons public domain Federal Writers Project poster",
  "Wikimedia Commons public domain art exhibition poster WPA",
  "Wikimedia Commons public domain library poster WPA",
  "Wikimedia Commons public domain public health poster WPA",
  "Wikimedia Commons public domain national park poster WPA",
  "Wikimedia Commons public domain theatre poster WPA",
  "Wikimedia Commons public domain dance poster WPA",
  "Wikimedia Commons public domain music poster WPA",
  "Wikimedia Commons public domain zoo poster WPA",
  "Wikimedia Commons public domain circus poster",
  "Wikimedia Commons public domain travel poster",
  "Wikimedia Commons public domain railway poster",
  "Wikimedia Commons public domain airline poster",
  "Wikimedia Commons public domain ocean liner poster",
  "Wikimedia Commons public domain national parks poster",
  "Wikimedia Commons public domain See America poster",
  "Wikimedia Commons public domain vintage poster affiche",
  "Wikimedia Commons public domain art nouveau poster affiche",
  "Wikimedia Commons public domain Jules Chéret poster",
  "Wikimedia Commons public domain Henri de Toulouse-Lautrec poster",
  "Wikimedia Commons public domain Alphonse Mucha poster",
  "Wikimedia Commons public domain Théophile Steinlen poster",
  "Wikimedia Commons public domain Edward Penfield poster",
  "Wikimedia Commons public domain Will Bradley poster",
  "Wikimedia Commons public domain Ludwig Hohlwein poster",
  "Wikimedia Commons public domain Koloman Moser poster",
  "Wikimedia Commons public domain Vienna Secession poster",
  "Wikimedia Commons public domain exhibition poster affiche",
  "Wikimedia Commons public domain colorful poster affiche",
  "Wikimedia Commons public domain propaganda poster",
  "Wikimedia Commons public domain World War I poster",
  "Wikimedia Commons public domain World War II poster",
  "Wikimedia Commons public domain food conservation poster",
  "Wikimedia Commons public domain war bonds poster",
  "Wikimedia Commons public domain Red Cross poster",
  "Wikimedia Commons public domain recruitment poster",
  "Wikimedia Commons public domain health poster",
  "Wikimedia Commons public domain safety poster",
  "Wikimedia Commons public domain book poster",
  "Wikimedia Commons public domain reading poster",
  "Wikimedia Commons public domain museum poster",
  "Wikimedia Commons public domain sports poster",
  "Wikimedia Commons public domain typography poster",
  "Wikimedia Commons public domain poster plakat",
  "Wikimedia Commons public domain Polish poster",
  "Wikimedia Commons public domain German poster plakat",
  "Wikimedia Commons public domain French poster affiche",
  "Wikimedia Commons public domain Italian poster manifesto",
  "Wikimedia Commons public domain Spanish poster cartel",
];

const artworks = JSON.parse(await fs.readFile(dataPath, "utf8"));
const byId = new Set(artworks.map((a) => a.id));
const titleKeys = new Set(
  artworks
    .filter((a) => a.source !== "svgrepo")
    .map((a) => titleKey(a.title))
    .filter(Boolean)
);
const imageHashes = new Set();

for (const artwork of artworks.filter((a) => a.source === "wikimedia")) {
  const imagePath = localImagePath(artwork.image?.localOriginalPath);
  if (!imagePath) continue;

  try {
    imageHashes.add(await dhash(await fs.readFile(imagePath)));
  } catch {
    // Ignore stale catalog paths.
  }
}

console.log(
  `duplicate index: ${titleKeys.size} titles, ${imageHashes.size} image hashes`
);

const stats = {
  added: 0,
  total: artworks.length,
  candidates: 0,
  skippedExisting: 0,
  skippedLicense: 0,
  skippedType: 0,
  skippedNotPoster: 0,
  skippedTitleDup: 0,
  skippedImageDup: 0,
  rejectedScore: 0,
  skippedDownload: 0,
};

for (const query of queries) {
  if (stats.added >= target) break;

  let perQueryAdded = 0;
  const pages = await search(query, 250);

  for (const page of pages) {
    if (stats.added >= target || perQueryAdded >= perQueryCap) break;
    stats.candidates++;

    const ii = page.imageinfo?.[0];
    if (!ii) continue;

    const sourceId = String(page.pageid);
    const id = `wikimedia:${sourceId}`;
    if (byId.has(id)) {
      stats.skippedExisting++;
      continue;
    }

    const originalUrl = ii.thumburl || ii.url;
    if (!originalUrl || !allowedRaster(ii.mime || "", originalUrl)) {
      stats.skippedType++;
      continue;
    }

    const meta = ii.extmetadata || {};
    const license = classifyLicense(
      ext(meta, "LicenseShortName"),
      ext(meta, "LicenseUrl"),
      ext(meta, "UsageTerms")
    );
    if (!license) {
      stats.skippedLicense++;
      continue;
    }

    const title = displayTitle(page.title);
    if (!looksLikePoster({ title, meta, categories: page.categories })) {
      stats.skippedNotPoster++;
      continue;
    }

    const key = titleKey(title);
    if (key && titleKeys.has(key)) {
      stats.skippedTitleDup++;
      continue;
    }

    let buffer;
    try {
      const response = await fetch(originalUrl, {
        headers: { Referer: sourceUrl(page.title) },
      });
      if (!response.ok) throw new Error(String(response.status));
      buffer = Buffer.from(await response.arrayBuffer());
    } catch {
      stats.skippedDownload++;
      continue;
    }

    let metadata;
    let score;
    let hash;
    try {
      metadata = await sharp(buffer).metadata();
      if (!metadata.width || !metadata.height) throw new Error("missing size");
      score = await scoreColorSimple(buffer);
      hash = await dhash(buffer);
    } catch {
      stats.skippedDownload++;
      continue;
    }

    if ([...imageHashes].some((candidate) => hamming(candidate, hash) <= 6)) {
      stats.skippedImageDup++;
      continue;
    }

    if (
      score.saturation < 13 ||
      score.colorfulness < 16 ||
      score.simplicity < 22 ||
      score.edgeDensity > 0.5 ||
      score.whiteShare > 0.8 ||
      score.blackShare > 0.8
    ) {
      stats.rejectedScore++;
      continue;
    }

    const outputDir = path.join(imagesRoot, "wikimedia", sourceId);
    await fs.mkdir(outputDir, { recursive: true });

    const extension = extFromMimeOrUrl(ii.mime || "", originalUrl);
    const originalPath = path.join(outputDir, `original${extension}`);
    await fs.writeFile(originalPath, buffer);

    const resized = {};
    for (const width of widths) {
      const outputPath = path.join(outputDir, `w${width}.jpg`);
      await sharp(buffer)
        .rotate()
        .resize({ width, withoutEnlargement: true })
        .jpeg({ quality: 82, mozjpeg: true })
        .toFile(outputPath);
      resized[String(width)] = `/images/wikimedia/${sourceId}/w${width}.jpg`;
    }

    const categories = (page.categories || [])
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
      tags: [
        ...categories,
        `colorfulness ${score.colorfulness.toFixed(1)}`,
        `saturation ${score.saturation.toFixed(1)}`,
        `simplicity ${score.simplicity.toFixed(1)}`,
        "dedupe title+hash",
        "poster batch",
      ],
      image: {
        originalUrl,
        width: metadata.width,
        height: metadata.height,
        localOriginalPath: `/images/wikimedia/${sourceId}/original${extension}`,
        localResizedPaths: resized,
      },
      search: {
        query: prefix + query,
        downloadedAt,
      },
    });

    byId.add(id);
    if (key) titleKeys.add(key);
    imageHashes.add(hash);
    stats.added++;
    stats.total = artworks.length;
    perQueryAdded++;
    console.log(
      `added ${stats.added}/${target}: ${title} (${metadata.width}x${metadata.height})`
    );
  }

  await saveCatalog();
  console.log(
    `query done: ${query} -> +${perQueryAdded}, total ${stats.added}/${target}`
  );
  await sleep(1500);
}

await saveCatalog();

console.log(JSON.stringify({ ...stats, total: artworks.length }, null, 2));

async function saveCatalog() {
  const tempPath = `${dataPath}.tmp-${process.pid}`;
  await fs.writeFile(tempPath, `${JSON.stringify(artworks, null, 2)}\n`);
  await fs.rename(tempPath, dataPath);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function localImagePath(publicPath) {
  if (!publicPath?.startsWith("/images/")) return undefined;
  return path.join(imagesRoot, publicPath.slice("/images/".length));
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
    .replace(/\b(file|poster|crop|copy|affiche|plakat|cartel|manifesto)\b/g, " ")
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

function looksLikePoster({ title, meta, categories }) {
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
    /photograph|photographs|snapshot|rally|demonstration|building|interior|exterior|logo|map|diagram|screenshot/.test(
      text
    )
  ) {
    return false;
  }

  return /poster|posters|affiche|plakat|cartel|manifesto|wpa|works progress|federal theatre|federal art project|federal music project|lccn/.test(
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
  const apiUrl = new URL("https://commons.wikimedia.org/w/api.php");
  apiUrl.searchParams.set("action", "query");
  apiUrl.searchParams.set("format", "json");
  apiUrl.searchParams.set("formatversion", "2");
  apiUrl.searchParams.set("generator", "search");
  apiUrl.searchParams.set("gsrnamespace", "6");
  apiUrl.searchParams.set("gsrlimit", String(limit));
  apiUrl.searchParams.set("gsrsearch", query);
  apiUrl.searchParams.set("prop", "imageinfo|categories");
  apiUrl.searchParams.set("cllimit", "50");
  apiUrl.searchParams.set("clshow", "!hidden");
  apiUrl.searchParams.set("iiprop", "url|mime|size|extmetadata");
  apiUrl.searchParams.set("iiurlwidth", "4000");
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

  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetch(apiUrl);
    if (response.ok) {
      const json = await response.json();
      return json.query?.pages || [];
    }

    if (response.status !== 429 || attempt === 3) {
      throw new Error(`search failed ${response.status}`);
    }

    const retryAfter = Number(response.headers.get("retry-after"));
    const waitMs =
      Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : (attempt + 1) * 15000;
    console.log(`search 429; waiting ${Math.round(waitMs / 1000)}s`);
    await sleep(waitMs);
  }

  return [];
}

async function scoreColorSimple(buffer) {
  const { data, info } = await sharp(buffer)
    .rotate()
    .resize({ width: 96, height: 96, fit: "inside" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let saturation = 0;
  let colorfulness = 0;
  let white = 0;
  let black = 0;
  let edges = 0;
  const count = info.width * info.height;
  const gray = new Float32Array(count);

  for (let i = 0, pixel = 0; i < data.length; i += 3, pixel++) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    saturation += max === 0 ? 0 : ((max - min) / max) * 100;
    colorfulness += Math.sqrt((r - g) ** 2 + (r - b) ** 2 + (g - b) ** 2);

    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    gray[pixel] = y;
    if (y > 238) white++;
    if (y < 20) black++;
  }

  for (let y = 1; y < info.height; y++) {
    for (let x = 1; x < info.width; x++) {
      const index = y * info.width + x;
      const delta =
        Math.abs(gray[index] - gray[index - 1]) +
        Math.abs(gray[index] - gray[index - info.width]);
      if (delta > 44) edges++;
    }
  }

  const unique = new Set();
  for (let i = 0; i < data.length; i += 12) {
    unique.add(`${data[i] >> 5},${data[i + 1] >> 5},${data[i + 2] >> 5}`);
  }

  return {
    saturation: saturation / count,
    colorfulness: colorfulness / count,
    simplicity: 100 - (unique.size / 512) * 100,
    edgeDensity: edges / Math.max(1, (info.width - 1) * (info.height - 1)),
    whiteShare: white / count,
    blackShare: black / count,
  };
}

async function dhash(buffer) {
  const { data } = await sharp(buffer)
    .rotate()
    .resize(9, 8, { fit: "fill" })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let bits = "";
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      bits += data[y * 9 + x] > data[y * 9 + x + 1] ? "1" : "0";
    }
  }

  return BigInt(`0b${bits}`).toString(16).padStart(16, "0");
}

function hamming(a, b) {
  let value = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let distance = 0;
  while (value) {
    distance += Number(value & 1n);
    value >>= 1n;
  }
  return distance;
}
