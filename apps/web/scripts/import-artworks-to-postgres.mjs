import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool } = pg;

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webRoot, "..", "..");

loadEnvFile(path.join(repoRoot, ".env"));
loadEnvFile(path.join(webRoot, ".env.local"));
loadEnvFile(path.join(webRoot, ".env"));

const sourcePath = process.env.ARTWORK_JSON_PATH?.trim()
  ? path.resolve(process.env.ARTWORK_JSON_PATH)
  : undefined;
const connectionString =
  process.env.DATABASE_URL?.trim() || process.env.POSTGRES_URL?.trim();

if (!connectionString) {
  throw new Error("DATABASE_URL is not configured");
}

if (!sourcePath) {
  throw new Error("ARTWORK_JSON_PATH is required for catalog imports");
}

if (!fs.existsSync(sourcePath)) {
  throw new Error(`Artwork JSON does not exist: ${sourcePath}`);
}

const raw = fs.readFileSync(sourcePath, "utf8");
const artworks = JSON.parse(raw);

if (!Array.isArray(artworks)) {
  throw new Error(`Artwork JSON must contain an array: ${sourcePath}`);
}

const pool = new Pool({
  connectionString,
  max: parsePositiveInt(process.env.DATABASE_POOL_MAX, 10),
  ssl:
    process.env.DATABASE_SSL === "true"
      ? { rejectUnauthorized: false }
      : undefined,
});

const client = await pool.connect();

try {
  await client.query("BEGIN");
  await client.query(getSchemaSql());

  await client.query("TRUNCATE artwork_tags, artworks");

  const artworkRows = [];
  const tagRows = [];

  for (const [index, artwork] of artworks.entries()) {
    const prepared = prepareArtworkRow(artwork, index);
    artworkRows.push(prepared.artwork);
    tagRows.push(...prepared.tags);
  }

  await insertArtworkRows(client, artworkRows);
  await insertTagRows(client, tagRows);

  const prunedCuration = await pruneOrphanedCurationRows(client);

  const count = Number(
    (await client.query("SELECT COUNT(*) AS count FROM artworks")).rows[0]
      ?.count ?? 0
  );
  if (count !== artworks.length) {
    throw new Error(
      `Postgres row count mismatch: expected ${artworks.length}, got ${count}`
    );
  }

  await client.query("COMMIT");

  console.log(
    JSON.stringify(
      {
        source: path.relative(webRoot, sourcePath),
        artworks: artworks.length,
        curation: {
          table: "artwork_curation",
          prunedOrphans: prunedCuration,
        },
      },
      null,
      2
    )
  );
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  await pool.end();
}

function requiredString(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Artwork is missing required field: ${field}`);
  }
  return value;
}

function optionalString(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function normalizeText(value) {
  return (value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function prepareArtworkRow(artwork, index) {
  const collectionName = artwork.collection?.name ?? null;
  const collectionUrl = artwork.collection?.url ?? null;
  const authorName = artwork.author?.name ?? null;
  const authorUrl = artwork.author?.url ?? null;
  const tags = Array.isArray(artwork.tags) ? artwork.tags : [];
  const searchQuery = artwork.search?.query ?? null;
  const downloadedAt = artwork.search?.downloadedAt ?? null;
  const searchContent = [
    artwork.title,
    artwork.description,
    artwork.artist,
    artwork.date,
    artwork.source,
    artwork.sourceId,
    artwork.license,
    artwork.rights,
    collectionName,
    authorName,
    searchQuery,
    ...tags,
  ]
    .filter(Boolean)
    .join(" ");

  return {
    artwork: [
      requiredString(artwork.id, "id"),
      index + 1,
      requiredString(artwork.source, "source"),
      requiredString(artwork.sourceId, "sourceId"),
      requiredString(artwork.title, "title"),
      optionalString(artwork.description),
      optionalString(artwork.artist),
      optionalString(artwork.date),
      artwork.isPublicDomain === true,
      requiredString(artwork.license, "license"),
      normalizeText(artwork.license),
      optionalString(artwork.rights),
      requiredString(artwork.sourceUrl, "sourceUrl"),
      optionalString(collectionName),
      normalizeText(collectionName),
      optionalString(collectionUrl),
      optionalString(authorName),
      optionalString(authorUrl),
      optionalString(searchQuery),
      optionalString(downloadedAt),
      JSON.stringify(artwork),
      searchContent,
    ],
    tags: tags.flatMap((tag) =>
      typeof tag === "string" && tag.trim().length > 0
        ? [[artwork.id, tag, normalizeText(tag)]]
        : []
    ),
  };
}

async function insertArtworkRows(client, rows) {
  const columns = `
    id,
    search_rowid,
    source,
    source_id,
    title,
    description,
    artist,
    date,
    is_public_domain,
    license,
    license_normalized,
    rights,
    source_url,
    collection_name,
    collection_name_normalized,
    collection_url,
    author_name,
    author_url,
    search_query,
    downloaded_at,
    payload_json,
    search_vector
  `;

  for (const batch of chunks(rows, 1000)) {
    const values = batch.flat();
    const placeholders = batch.map((row, rowIndex) => {
      const base = rowIndex * row.length;
      return `(${row
        .map((_, columnIndex) =>
          columnIndex === 21
            ? `to_tsvector('simple', $${base + columnIndex + 1})`
            : `$${base + columnIndex + 1}`
        )
        .join(", ")})`;
    });

    await client.query(
      `INSERT INTO artworks (${columns}) VALUES ${placeholders.join(", ")}`,
      values
    );
  }
}

async function insertTagRows(client, rows) {
  for (const batch of chunks(rows, 10000)) {
    const values = batch.flat();
    const placeholders = batch.map((row, rowIndex) => {
      const base = rowIndex * row.length;
      return `($${base + 1}, $${base + 2}, $${base + 3})`;
    });

    await client.query(
      `INSERT INTO artwork_tags (artwork_id, tag, tag_normalized)
       VALUES ${placeholders.join(", ")}
       ON CONFLICT DO NOTHING`,
      values
    );
  }
}

async function pruneOrphanedCurationRows(client) {
  const result = await client.query(
    `DELETE FROM artwork_curation c
     WHERE NOT EXISTS (
       SELECT 1
       FROM artworks a
       WHERE a.id = c.id
     )`
  );

  return result.rowCount ?? 0;
}

function chunks(items, size) {
  const result = [];

  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }

  return result;
}

function parsePositiveInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.trunc(parsed);
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;

  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
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

function getSchemaSql() {
  return `
  CREATE TABLE IF NOT EXISTS artworks (
    id TEXT PRIMARY KEY,
    search_rowid INTEGER NOT NULL UNIQUE,
    source TEXT NOT NULL,
    source_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    artist TEXT,
    date TEXT,
    is_public_domain BOOLEAN NOT NULL,
    license TEXT NOT NULL,
    license_normalized TEXT NOT NULL,
    rights TEXT,
    source_url TEXT NOT NULL,
    collection_name TEXT,
    collection_name_normalized TEXT NOT NULL,
    collection_url TEXT,
    author_name TEXT,
    author_url TEXT,
    search_query TEXT,
    downloaded_at TEXT,
    payload_json JSONB NOT NULL,
    search_vector TSVECTOR NOT NULL
  );

  CREATE TABLE IF NOT EXISTS artwork_tags (
    artwork_id TEXT NOT NULL REFERENCES artworks(id) ON DELETE CASCADE,
    tag TEXT NOT NULL,
    tag_normalized TEXT NOT NULL,
    PRIMARY KEY (artwork_id, tag)
  );

  CREATE TABLE IF NOT EXISTS artwork_curation (
    id TEXT PRIMARY KEY,
    highlighted BOOLEAN NOT NULL DEFAULT FALSE,
    rating INTEGER CHECK (rating BETWEEN 1 AND 5)
  );

  ALTER TABLE artwork_curation
    DROP CONSTRAINT IF EXISTS artwork_curation_id_fkey;

  CREATE INDEX IF NOT EXISTS idx_artworks_source ON artworks(source);
  CREATE INDEX IF NOT EXISTS idx_artworks_public_domain ON artworks(is_public_domain);
  CREATE INDEX IF NOT EXISTS idx_artworks_license ON artworks(license_normalized);
  CREATE INDEX IF NOT EXISTS idx_artworks_collection ON artworks(collection_name_normalized);
  CREATE INDEX IF NOT EXISTS idx_artworks_downloaded_at ON artworks(downloaded_at);
  CREATE INDEX IF NOT EXISTS idx_artworks_search_vector ON artworks USING GIN(search_vector);
  CREATE INDEX IF NOT EXISTS idx_artwork_tags_lookup ON artwork_tags(tag_normalized, artwork_id);
  CREATE INDEX IF NOT EXISTS idx_artwork_curation_highlighted ON artwork_curation(highlighted);
  CREATE INDEX IF NOT EXISTS idx_artwork_curation_rating ON artwork_curation(rating);
`;
}
