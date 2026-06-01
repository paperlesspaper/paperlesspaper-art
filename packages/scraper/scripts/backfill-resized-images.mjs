#!/usr/bin/env node

import fsSync from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const scraperRoot = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(scraperRoot, "..", "..");
const webRoot = path.join(repoRoot, "apps", "web");
const pg = await loadPg();
const { Pool } = pg;

loadEnvFile(path.join(repoRoot, ".env"));
loadEnvFile(path.join(webRoot, ".env.local"));
loadEnvFile(path.join(webRoot, ".env"));

const connectionString =
  process.env.DATABASE_URL?.trim() || process.env.POSTGRES_URL?.trim();
const imagesRoot = process.env.ARTWORK_IMAGES_ROOT
  ? path.resolve(process.env.ARTWORK_IMAGES_ROOT)
  : path.join(webRoot, "public", "images");
const widths = (process.env.WIDTHS ?? "512,1024")
  .split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value > 0);
const limit = parsePositiveInt(process.env.LIMIT);

if (!connectionString) {
  throw new Error("DATABASE_URL or POSTGRES_URL is required");
}

if (widths.length === 0) {
  throw new Error("WIDTHS must contain at least one positive integer");
}

const pool = new Pool({
  connectionString,
  max: parsePositiveInt(process.env.DATABASE_POOL_MAX) ?? 4,
  ssl:
    process.env.DATABASE_SSL === "true"
      ? { rejectUnauthorized: false }
      : undefined,
});

const client = await pool.connect();
const stats = {
  checked: 0,
  updated: 0,
  generated: 0,
  skippedMissingOriginal: 0,
  skippedUnsupported: 0,
};

try {
  const rows = await loadRows(client);

  for (const row of rows) {
    stats.checked++;

    const artwork =
      typeof row.payload_json === "string"
        ? JSON.parse(row.payload_json)
        : row.payload_json;
    const originalPublicPath = artwork?.image?.localOriginalPath;

    if (!isResizablePublicPath(originalPublicPath)) {
      stats.skippedUnsupported++;
      continue;
    }

    const originalPath = publicImagePathToFilePath(originalPublicPath);
    if (!fsSync.existsSync(originalPath)) {
      stats.skippedMissingOriginal++;
      continue;
    }

    const nextResizedPaths = {
      ...(artwork.image.localResizedPaths ?? {}),
    };
    let changed = false;

    for (const width of widths) {
      const key = String(width);
      const publicPath =
        nextResizedPaths[key] ?? siblingPublicPath(originalPublicPath, width);
      const outputPath = publicImagePathToFilePath(publicPath);

      if (!fsSync.existsSync(outputPath)) {
        await sharp(originalPath, { failOn: "none" })
          .rotate()
          .resize({ width, withoutEnlargement: true })
          .jpeg({ quality: 82, mozjpeg: true })
          .toFile(outputPath);
        stats.generated++;
      }

      if (nextResizedPaths[key] !== publicPath) {
        nextResizedPaths[key] = publicPath;
        changed = true;
      }
    }

    if (!changed) continue;

    artwork.image.localResizedPaths = nextResizedPaths;
    await client.query("UPDATE artworks SET payload_json = $2 WHERE id = $1", [
      row.id,
      JSON.stringify(artwork),
    ]);
    stats.updated++;
  }
} finally {
  client.release();
  await pool.end();
}

console.log(JSON.stringify(stats, null, 2));

async function loadRows(client) {
  const missingWidthClauses = widths
    .map((width, index) => `(payload_json #> $${index + 1}) IS NULL`)
    .join(" OR ");
  const params = widths.map((width) => ["image", "localResizedPaths", String(width)]);
  const limitClause = limit ? `LIMIT ${limit}` : "";

  const result = await client.query(
    `SELECT id, payload_json
     FROM artworks
     WHERE source <> 'svgrepo'
       AND payload_json #>> '{image,localOriginalPath}' IS NOT NULL
       AND (${missingWidthClauses})
     ORDER BY id
     ${limitClause}`,
    params
  );

  return result.rows;
}

function isResizablePublicPath(value) {
  return (
    typeof value === "string" &&
    value.startsWith("/images/") &&
    !value.toLowerCase().split("?")[0].endsWith(".svg")
  );
}

function publicImagePathToFilePath(publicPath) {
  return path.join(imagesRoot, publicPath.replace(/^\/images\/+/, ""));
}

function siblingPublicPath(originalPublicPath, width) {
  return `${path.posix.dirname(originalPublicPath)}/w${width}.jpg`;
}

function parsePositiveInt(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : undefined;
}

function loadEnvFile(filePath) {
  if (!fsSync.existsSync(filePath)) return;

  for (const line of fsSync.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex === -1) continue;

    const key = trimmed.slice(0, equalsIndex).trim();
    const rawValue = trimmed.slice(equalsIndex + 1).trim();
    if (!key || process.env[key] !== undefined) continue;

    process.env[key] = rawValue.replace(/^['"]|['"]$/g, "");
  }
}

async function loadPg() {
  try {
    return await import("pg");
  } catch {
    const requireFromWeb = createRequire(path.join(webRoot, "package.json"));
    return requireFromWeb("pg");
  }
}
