import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(scriptDir, "..");
const dataDir = path.join(webRoot, "data");
const sourcePath = process.env.ARTWORK_JSON_PATH
  ? path.resolve(process.env.ARTWORK_JSON_PATH)
  : path.join(dataDir, "artworks.json");
const outputPath = process.env.ARTWORK_DB_PATH
  ? path.resolve(process.env.ARTWORK_DB_PATH)
  : path.join(dataDir, "artworks.sqlite");
const tempPath = `${outputPath}.tmp`;

if (!fs.existsSync(sourcePath)) {
  throw new Error(`Artwork JSON does not exist: ${sourcePath}`);
}

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);

const raw = fs.readFileSync(sourcePath, "utf8");
const artworks = JSON.parse(raw);

if (!Array.isArray(artworks)) {
  throw new Error(`Artwork JSON must contain an array: ${sourcePath}`);
}

const db = new Database(tempPath);

try {
  db.pragma("journal_mode = DELETE");
  db.pragma("synchronous = NORMAL");
  db.pragma("temp_store = MEMORY");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE artworks (
      id TEXT PRIMARY KEY,
      search_rowid INTEGER NOT NULL UNIQUE,
      source TEXT NOT NULL,
      source_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      artist TEXT,
      date TEXT,
      is_public_domain INTEGER NOT NULL,
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
      payload_json TEXT NOT NULL
    );

    CREATE TABLE artwork_tags (
      artwork_id TEXT NOT NULL,
      tag TEXT NOT NULL,
      tag_normalized TEXT NOT NULL,
      PRIMARY KEY (artwork_id, tag),
      FOREIGN KEY (artwork_id) REFERENCES artworks(id) ON DELETE CASCADE
    );

    CREATE VIRTUAL TABLE artwork_fts USING fts5(
      content,
      content = '',
      tokenize = 'unicode61 remove_diacritics 2'
    );

    CREATE INDEX idx_artworks_source ON artworks(source);
    CREATE INDEX idx_artworks_public_domain ON artworks(is_public_domain);
    CREATE INDEX idx_artworks_license ON artworks(license_normalized);
    CREATE INDEX idx_artworks_collection ON artworks(collection_name_normalized);
    CREATE INDEX idx_artworks_downloaded_at ON artworks(downloaded_at);
    CREATE INDEX idx_artwork_tags_lookup ON artwork_tags(tag_normalized, artwork_id);
  `);

  const insertArtwork = db.prepare(`
    INSERT INTO artworks (
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
      payload_json
    ) VALUES (
      @id,
      @searchRowid,
      @source,
      @sourceId,
      @title,
      @description,
      @artist,
      @date,
      @isPublicDomain,
      @license,
      @licenseNormalized,
      @rights,
      @sourceUrl,
      @collectionName,
      @collectionNameNormalized,
      @collectionUrl,
      @authorName,
      @authorUrl,
      @searchQuery,
      @downloadedAt,
      @payloadJson
    )
  `);
  const insertTag = db.prepare(`
    INSERT OR IGNORE INTO artwork_tags (artwork_id, tag, tag_normalized)
    VALUES (?, ?, ?)
  `);
  const insertFts = db.prepare(`
    INSERT INTO artwork_fts (rowid, content)
    VALUES (?, ?)
  `);

  const insertAll = db.transaction((items) => {
    for (const [index, artwork] of items.entries()) {
      const collectionName = artwork.collection?.name ?? null;
      const collectionUrl = artwork.collection?.url ?? null;
      const authorName = artwork.author?.name ?? null;
      const authorUrl = artwork.author?.url ?? null;
      const tags = Array.isArray(artwork.tags) ? artwork.tags : [];
      const searchQuery = artwork.search?.query ?? null;
      const downloadedAt = artwork.search?.downloadedAt ?? null;

      insertArtwork.run({
        id: requiredString(artwork.id, "id"),
        searchRowid: index + 1,
        source: requiredString(artwork.source, "source"),
        sourceId: requiredString(artwork.sourceId, "sourceId"),
        title: requiredString(artwork.title, "title"),
        description: optionalString(artwork.description),
        artist: optionalString(artwork.artist),
        date: optionalString(artwork.date),
        isPublicDomain: artwork.isPublicDomain === true ? 1 : 0,
        license: requiredString(artwork.license, "license"),
        licenseNormalized: normalizeText(artwork.license),
        rights: optionalString(artwork.rights),
        sourceUrl: requiredString(artwork.sourceUrl, "sourceUrl"),
        collectionName: optionalString(collectionName),
        collectionNameNormalized: normalizeText(collectionName),
        collectionUrl: optionalString(collectionUrl),
        authorName: optionalString(authorName),
        authorUrl: optionalString(authorUrl),
        searchQuery: optionalString(searchQuery),
        downloadedAt: optionalString(downloadedAt),
        payloadJson: JSON.stringify(artwork),
      });

      for (const tag of tags) {
        if (typeof tag !== "string" || tag.trim().length === 0) continue;
        insertTag.run(artwork.id, tag, normalizeText(tag));
      }

      insertFts.run(
        index + 1,
        [
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
          .join(" ")
      );
    }
  });

  insertAll(artworks);

  const count = db.prepare("SELECT COUNT(*) AS count FROM artworks").get().count;
  if (count !== artworks.length) {
    throw new Error(
      `SQLite row count mismatch: expected ${artworks.length}, got ${count}`
    );
  }
} finally {
  db.close();
}

if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
fs.renameSync(tempPath, outputPath);

console.log(
  JSON.stringify(
    {
      source: path.relative(webRoot, sourcePath),
      output: path.relative(webRoot, outputPath),
      artworks: artworks.length,
    },
    null,
    2
  )
);

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
