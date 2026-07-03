import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const scraperRoot = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(scraperRoot, "..", "..");
const webRoot = path.join(repoRoot, "apps", "web");

loadEnvFile(path.join(repoRoot, ".env"));
loadEnvFile(path.join(webRoot, ".env.local"));
loadEnvFile(path.join(webRoot, ".env"));

let pool;
let readyPromise;
let writeQueue = Promise.resolve();

export function isArtworkDatabaseConfigured() {
  return Boolean(getDatabaseUrl());
}

export async function closeArtworkDatabase() {
  await writeQueue;
  await pool?.end();
  pool = undefined;
  readyPromise = undefined;
}

export async function upsertArtworkInDatabase(artwork) {
  if (!isArtworkDatabaseConfigured()) return false;

  writeQueue = writeQueue.then(() => upsertArtworkInDatabaseNow(artwork));
  return writeQueue;
}

export async function loadArtworkDuplicateIndexFromDatabase() {
  if (!isArtworkDatabaseConfigured()) return [];

  const client = await (await getPool()).connect();

  try {
    await ensureArtworkDatabase(client);

    const result = await client.query(
      `SELECT
          id,
          source,
          title,
          payload_json #>> '{image,wikimediaSha1}' AS "wikimediaSha1",
          payload_json #>> '{image,sha1}' AS sha1
       FROM artworks`
    );

    return result.rows.map((row) => ({
      id: row.id,
      source: row.source,
      title: row.title,
      image: {
        wikimediaSha1: row.wikimediaSha1 || undefined,
        sha1: row.sha1 || undefined,
      },
    }));
  } finally {
    client.release();
  }
}

export async function loadWikimediaPreviewDecisionsFromDatabase() {
  if (!isArtworkDatabaseConfigured()) return [];

  const client = await (await getPool()).connect();

  try {
    await ensureArtworkDatabase(client);

    const result = await client.query(
      `SELECT
          id,
          source_id AS "sourceId",
          decision,
          (metadata_json ->> 'rating')::integer AS rating
       FROM wikimedia_preview_decisions`
    );

    return result.rows.map((row) => ({
      id: row.id,
      sourceId: row.sourceId,
      decision: row.decision,
      rating: row.rating,
    }));
  } finally {
    client.release();
  }
}

export async function setArtworkCurationRatingInDatabase(id, rating) {
  if (!isArtworkDatabaseConfigured()) return false;

  writeQueue = writeQueue.then(() =>
    setArtworkCurationRatingInDatabaseNow(id, rating)
  );
  return writeQueue;
}

export async function upsertWikimediaPreviewDecisionInDatabase(decision) {
  if (!isArtworkDatabaseConfigured()) return false;

  writeQueue = writeQueue.then(() =>
    upsertWikimediaPreviewDecisionInDatabaseNow(decision)
  );
  return writeQueue;
}

async function upsertArtworkInDatabaseNow(artwork) {
  const client = await (await getPool()).connect();

  try {
    await client.query("BEGIN");
    await ensureArtworkDatabase(client);

    const prepared = prepareArtworkRow(artwork);
    const result = await client.query(
      `INSERT INTO artworks (
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
       )
       VALUES (
          $1,
          COALESCE((SELECT MAX(search_rowid) + 1 FROM artworks), 1),
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          $9,
          $10,
          $11,
          $12,
          $13,
          $14,
          $15,
          $16,
          $17,
          $18,
          $19,
          $20,
          to_tsvector('simple', $21)
       )
       ON CONFLICT (id)
       DO UPDATE SET
          source = EXCLUDED.source,
          source_id = EXCLUDED.source_id,
          title = EXCLUDED.title,
          description = EXCLUDED.description,
          artist = EXCLUDED.artist,
          date = EXCLUDED.date,
          is_public_domain = EXCLUDED.is_public_domain,
          license = EXCLUDED.license,
          license_normalized = EXCLUDED.license_normalized,
          rights = EXCLUDED.rights,
          source_url = EXCLUDED.source_url,
          collection_name = EXCLUDED.collection_name,
          collection_name_normalized = EXCLUDED.collection_name_normalized,
          collection_url = EXCLUDED.collection_url,
          author_name = EXCLUDED.author_name,
          author_url = EXCLUDED.author_url,
          search_query = EXCLUDED.search_query,
          downloaded_at = EXCLUDED.downloaded_at,
          payload_json = EXCLUDED.payload_json,
          search_vector = EXCLUDED.search_vector
       RETURNING (xmax = 0) AS inserted`,
      prepared.artwork
    );

    await client.query("DELETE FROM artwork_tags WHERE artwork_id = $1", [
      artwork.id,
    ]);

    for (const batch of chunks(prepared.tags, 1000)) {
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

    await client.query("COMMIT");
    const inserted = result.rows[0]?.inserted === true;
    return { inserted, updated: !inserted };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function upsertWikimediaPreviewDecisionInDatabaseNow(decision) {
  const client = await (await getPool()).connect();

  try {
    await ensureArtworkDatabase(client);

    const decidedAt =
      optionalString(decision.decidedAt) ?? new Date().toISOString();
    const metadata =
      decision.metadata && typeof decision.metadata === "object"
        ? decision.metadata
        : {};

    await client.query(
      `INSERT INTO wikimedia_preview_decisions (
          id,
          source_id,
          title,
          search_query,
          decision,
          preview_url,
          preview_local_path,
          source_url,
          decided_at,
          created_at,
          updated_at,
          metadata_json
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, $9, $10)
       ON CONFLICT (id)
       DO UPDATE SET
          source_id = EXCLUDED.source_id,
          title = EXCLUDED.title,
          search_query = EXCLUDED.search_query,
          decision = EXCLUDED.decision,
          preview_url = EXCLUDED.preview_url,
          preview_local_path = EXCLUDED.preview_local_path,
          source_url = EXCLUDED.source_url,
          decided_at = EXCLUDED.decided_at,
          updated_at = EXCLUDED.updated_at,
          metadata_json = EXCLUDED.metadata_json`,
      [
        requiredString(decision.id, "id"),
        requiredString(decision.sourceId, "sourceId"),
        requiredString(decision.title, "title"),
        optionalString(decision.query),
        requiredPreviewDecision(decision.decision),
        optionalString(decision.previewUrl),
        optionalString(decision.previewLocalPath),
        optionalString(decision.sourceUrl),
        decidedAt,
        JSON.stringify(metadata),
      ]
    );

    return true;
  } finally {
    client.release();
  }
}

async function setArtworkCurationRatingInDatabaseNow(id, rating) {
  const normalizedRating = Number(rating);
  if (
    !Number.isInteger(normalizedRating) ||
    normalizedRating < 1 ||
    normalizedRating > 5
  ) {
    return false;
  }

  const client = await (await getPool()).connect();

  try {
    await ensureArtworkDatabase(client);
    await client.query(
      `INSERT INTO artwork_curation (id, highlighted, rating)
       VALUES ($1, FALSE, $2)
       ON CONFLICT (id)
       DO UPDATE SET rating = EXCLUDED.rating`,
      [requiredString(id, "id"), normalizedRating]
    );

    return true;
  } finally {
    client.release();
  }
}

async function getPool() {
  if (pool) return pool;

  const connectionString = getDatabaseUrl();
  if (!connectionString) {
    throw new Error("DATABASE_URL is not configured");
  }

  const pg = await loadPg();
  pool = new pg.Pool({
    connectionString,
    max: parsePositiveInt(process.env.DATABASE_POOL_MAX, 4),
    ssl:
      process.env.DATABASE_SSL === "true"
        ? { rejectUnauthorized: false }
        : undefined,
  });

  return pool;
}

async function ensureArtworkDatabase(client) {
  if (!readyPromise) {
    readyPromise = client.query(SCHEMA_SQL).then();
  }

  await readyPromise;
}

async function loadPg() {
  try {
    return await import("pg");
  } catch (error) {
    const requireFromWeb = createRequire(
      pathToFileURL(path.join(webRoot, "package.json"))
    );
    return requireFromWeb("pg");
  }
}

function getDatabaseUrl() {
  return process.env.DATABASE_URL?.trim() || process.env.POSTGRES_URL?.trim();
}

function prepareArtworkRow(artwork) {
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

function requiredString(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Artwork is missing required field: ${field}`);
  }

  return value;
}

function requiredPreviewDecision(value) {
  if (value === "pending" || value === "approved" || value === "rejected") {
    return value;
  }
  throw new Error("Preview decision must be pending, approved, or rejected");
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

const SCHEMA_SQL = `
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

  CREATE TABLE IF NOT EXISTS wikimedia_preview_decisions (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL,
    title TEXT NOT NULL,
    search_query TEXT,
    decision TEXT NOT NULL CHECK (decision IN ('pending', 'approved', 'rejected')),
    preview_url TEXT,
    preview_local_path TEXT,
    source_url TEXT,
    decided_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb
  );

  ALTER TABLE artwork_curation
    DROP CONSTRAINT IF EXISTS artwork_curation_id_fkey;

  ALTER TABLE wikimedia_preview_decisions
    DROP CONSTRAINT IF EXISTS wikimedia_preview_decisions_decision_check;

  ALTER TABLE wikimedia_preview_decisions
    ADD CONSTRAINT wikimedia_preview_decisions_decision_check
    CHECK (decision IN ('pending', 'approved', 'rejected'));

  CREATE INDEX IF NOT EXISTS idx_artworks_source ON artworks(source);
  CREATE INDEX IF NOT EXISTS idx_artworks_public_domain ON artworks(is_public_domain);
  CREATE INDEX IF NOT EXISTS idx_artworks_license ON artworks(license_normalized);
  CREATE INDEX IF NOT EXISTS idx_artworks_collection ON artworks(collection_name_normalized);
  CREATE INDEX IF NOT EXISTS idx_artworks_downloaded_at ON artworks(downloaded_at);
  CREATE INDEX IF NOT EXISTS idx_artworks_search_vector ON artworks USING GIN(search_vector);
  CREATE INDEX IF NOT EXISTS idx_artwork_tags_lookup ON artwork_tags(tag_normalized, artwork_id);
  CREATE INDEX IF NOT EXISTS idx_artwork_curation_highlighted ON artwork_curation(highlighted);
  CREATE INDEX IF NOT EXISTS idx_artwork_curation_rating ON artwork_curation(rating);
  CREATE INDEX IF NOT EXISTS idx_wikimedia_preview_decisions_decision ON wikimedia_preview_decisions(decision);
  CREATE INDEX IF NOT EXISTS idx_wikimedia_preview_decisions_decided_at ON wikimedia_preview_decisions(decided_at);
`;
