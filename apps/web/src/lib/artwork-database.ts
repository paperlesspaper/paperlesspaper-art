import { Pool } from "pg";

declare global {
  var artworkPostgresPool: Pool | undefined;
  var artworkPostgresConnectionString: string | undefined;
  var artworkDatabaseReady: Promise<void> | undefined;
}

export type QueryParam = string | number | boolean | null;

export function getArtworkPool() {
  const connectionString = getDatabaseUrl();

  if (
    globalThis.artworkPostgresPool &&
    globalThis.artworkPostgresConnectionString === connectionString
  ) {
    return globalThis.artworkPostgresPool;
  }

  globalThis.artworkPostgresPool?.end().catch(() => undefined);
  globalThis.artworkPostgresPool = new Pool({
    connectionString,
    max: parsePositiveInt(process.env.DATABASE_POOL_MAX, 10),
    ssl:
      process.env.DATABASE_SSL === "true"
        ? { rejectUnauthorized: false }
        : undefined,
  });
  globalThis.artworkPostgresConnectionString = connectionString;
  globalThis.artworkDatabaseReady = undefined;

  return globalThis.artworkPostgresPool;
}

export async function ensureArtworkDatabase() {
  if (!globalThis.artworkDatabaseReady) {
    globalThis.artworkDatabaseReady = getArtworkPool().query(SCHEMA_SQL).then();
  }

  await globalThis.artworkDatabaseReady;
}

function getDatabaseUrl() {
  const value =
    process.env.DATABASE_URL?.trim() || process.env.POSTGRES_URL?.trim();

  if (!value) {
    throw new Error("DATABASE_URL is not configured");
  }

  return value;
}

function parsePositiveInt(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.trunc(parsed);
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
