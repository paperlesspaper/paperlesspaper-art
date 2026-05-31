import Database from "better-sqlite3";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  curationFilePath,
  loadArtworkCurationSync,
  type ArtworkCurationItem,
} from "@/lib/artwork-curation";
import type { Database as SqliteDatabase } from "better-sqlite3";

export type ArtworkSource = "met" | "artic" | "svgrepo" | "wikimedia";

export type Artwork = {
  id: string;
  source: ArtworkSource;
  sourceId: string;
  title: string;
  description?: string;
  artist?: string;
  date?: string;
  isPublicDomain: boolean;
  license: string;
  licenseUrl?: string;
  rights?: string;
  sourceUrl: string;
  collection?: {
    name: string;
    url: string;
  };
  author?: {
    name: string;
    url: string;
  };
  tags?: string[];
  image: {
    originalUrl: string;
    width?: number;
    height?: number;
    localOriginalPath?: string;
    localResizedPaths?: Record<string, string>;
  };
  search: {
    query: string;
    downloadedAt: string;
  };
};

export type ArtworkApiItem = Omit<Artwork, "image"> & {
  image: Artwork["image"] & {
    url?: string;
    resizedUrls?: Record<string, string>;
  };
  selected: boolean;
  highlighted: boolean;
  rating?: 1 | 2 | 3 | 4 | 5;
};

export type ArtworkSearchFilters = {
  q?: string;
  source?: ArtworkSource;
  publicDomain?: boolean;
  license?: string;
  tag?: string;
  collection?: string;
  selected?: boolean;
  highlighted?: boolean;
  rating?: 1 | 2 | 3 | 4 | 5 | "rated" | "unrated";
  limit?: number;
  offset?: number;
};

export type ArtworkCatalogMeta = {
  totalCatalogItems: number;
  sourceCounts: Partial<Record<ArtworkSource, number>>;
  sources: ArtworkSource[];
  curation: {
    highlighted: number;
    rated: number;
  };
};

export type ArtworkCatalogSearchResult = {
  items: ArtworkApiItem[];
  total: number;
  limit: number;
  offset: number;
  meta: ArtworkCatalogMeta;
};

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;

let cachedCatalog:
  | {
      items: Artwork[];
      loadedAt: number;
      sourceKey: string;
    }
  | undefined;

let cachedArtworkDb:
  | {
      db: SqliteDatabase;
      dbPath: string;
      sourceCounts: Partial<Record<ArtworkSource, number>>;
      sources: ArtworkSource[];
      totalCatalogItems: number;
      curationStamp: string;
    }
  | undefined;

function dataFilePath() {
  return path.join(process.cwd(), "data", "artworks.json");
}

export async function loadArtworks(): Promise<Artwork[]> {
  const catalogUrl = process.env.ART_CATALOG_URL?.trim();
  const sourceKey = catalogUrl || dataFilePath();
  const cacheTtlMs = parsePositiveInt(
    process.env.ART_CATALOG_CACHE_TTL_MS,
    DEFAULT_CACHE_TTL_MS
  );
  const now = Date.now();

  if (
    cachedCatalog &&
    cachedCatalog.sourceKey === sourceKey &&
    now - cachedCatalog.loadedAt < cacheTtlMs
  ) {
    return cachedCatalog.items;
  }

  try {
    const raw = catalogUrl
      ? await fetchTextCatalog(catalogUrl)
      : await fs.readFile(dataFilePath(), "utf8");
    const parsed = JSON.parse(raw);
    const items = Array.isArray(parsed) ? (parsed as Artwork[]) : [];
    cachedCatalog = { items, loadedAt: now, sourceKey };
    return items;
  } catch {
    if (cachedCatalog?.sourceKey === sourceKey) return cachedCatalog.items;
    return [];
  }
}

export function searchArtworks(
  artworks: Artwork[],
  filters: ArtworkSearchFilters,
  curation: Record<string, ArtworkCurationItem> = {}
) {
  const q = normalizeText(filters.q);
  const queryTerms = q.length > 0 ? q.split(" ").filter(Boolean) : [];
  const source = filters.source;
  const license = normalizeText(filters.license);
  const tag = normalizeText(filters.tag);
  const collection = normalizeText(filters.collection);
  const publicDomain = filters.publicDomain;
  const selected =
    typeof filters.selected === "boolean"
      ? filters.selected
      : filters.highlighted;
  const rating = filters.rating;
  const limit = clampLimit(filters.limit);
  const offset = Math.max(0, filters.offset ?? 0);

  const scored = artworks
    .map((artwork, index) => {
      const curationItem = curation[artwork.id] ?? {};
      const isSelected = curationItem.highlighted === true;

      if (source && artwork.source !== source) return null;
      if (
        typeof publicDomain === "boolean" &&
        artwork.isPublicDomain !== publicDomain
      ) {
        return null;
      }
      if (license && !normalizeText(artwork.license).includes(license)) {
        return null;
      }
      if (
        tag &&
        !(artwork.tags ?? []).some((candidate) =>
          normalizeText(candidate).includes(tag)
        )
      ) {
        return null;
      }
      if (
        collection &&
        !normalizeText(artwork.collection?.name).includes(collection)
      ) {
        return null;
      }
      if (typeof selected === "boolean" && isSelected !== selected) {
        return null;
      }
      if (rating === "rated" && !curationItem.rating) {
        return null;
      }
      if (rating === "unrated" && curationItem.rating) {
        return null;
      }
      if (
        typeof rating === "number" &&
        curationItem.rating !== rating
      ) {
        return null;
      }

      const score = queryTerms.length > 0 ? scoreArtwork(artwork, queryTerms) : 0;
      if (queryTerms.length > 0 && score === 0) return null;

      return { artwork, score, index };
    })
    .filter((item): item is { artwork: Artwork; score: number; index: number } =>
      Boolean(item)
    );

  scored.sort((a, b) => {
    const ratingDifference =
      getRatingSortValue(curation[b.artwork.id]) -
      getRatingSortValue(curation[a.artwork.id]);
    if (ratingDifference !== 0) return ratingDifference;

    if (queryTerms.length > 0 && b.score !== a.score) {
      return b.score - a.score;
    }

    return (
      a.artwork.title.localeCompare(b.artwork.title) ||
      compareDownloadedAt(a.artwork, b.artwork) ||
      a.index - b.index
    );
  });

  const total = scored.length;
  const items = scored
    .slice(offset, offset + limit)
    .map(({ artwork }) => toApiArtwork(artwork, curation[artwork.id]));

  return { items, total, limit, offset };
}

export function searchArtworkCatalog(
  filters: ArtworkSearchFilters
): ArtworkCatalogSearchResult {
  const db = getArtworkDatabase();
  refreshCurationTable(db);

  const limit = clampLimit(filters.limit);
  const offset = Math.max(0, filters.offset ?? 0);
  const query = buildArtworkSql(filters);
  const params = { ...query.params, limit, offset };

  const total =
    db.db
      .prepare<Record<string, string | number>, { total: number }>(
        `SELECT COUNT(*) AS total
         FROM artworks a
         ${query.ftsJoin}
         LEFT JOIN temp.artwork_curation c ON c.id = a.id
         ${query.whereSql}`
      )
      .get(query.params)?.total ?? 0;

  const rankColumn = query.ftsJoin ? "bm25(artwork_fts)" : "0";
  const rankOrder = query.ftsJoin ? "search_rank ASC," : "";
  const rows = db.db
    .prepare<Record<string, string | number>, ArtworkRow>(
      `SELECT
          a.payload_json AS payloadJson,
          COALESCE(c.highlighted, 0) AS highlighted,
          c.rating AS rating,
          ${rankColumn} AS search_rank
       FROM artworks a
       ${query.ftsJoin}
       LEFT JOIN temp.artwork_curation c ON c.id = a.id
       ${query.whereSql}
       ORDER BY
          COALESCE(c.rating, 0) DESC,
          ${rankOrder}
          a.title COLLATE NOCASE ASC,
          a.downloaded_at DESC,
          a.id ASC
       LIMIT @limit OFFSET @offset`
    )
    .all(params);

  return {
    items: rows.map(rowToApiArtwork),
    total,
    limit,
    offset,
    meta: getArtworkCatalogMeta(),
  };
}

export function findArtworkInCatalogById(id: string) {
  const db = getArtworkDatabase();
  refreshCurationTable(db);

  const row = db.db
    .prepare<{ id: string }, ArtworkRow>(
      `SELECT
          a.payload_json AS payloadJson,
          COALESCE(c.highlighted, 0) AS highlighted,
          c.rating AS rating
       FROM artworks a
       LEFT JOIN temp.artwork_curation c ON c.id = a.id
       WHERE a.id = @id
       LIMIT 1`
    )
    .get({ id });

  return row ? rowToApiArtwork(row) : undefined;
}

export function getArtworkCatalogMeta(): ArtworkCatalogMeta {
  const db = getArtworkDatabase();
  refreshCurationTable(db);

  const curation =
    db.db
      .prepare<
        [],
        {
          highlighted: number;
          rated: number;
        }
      >(
        `SELECT
            SUM(CASE WHEN highlighted = 1 THEN 1 ELSE 0 END) AS highlighted,
            SUM(CASE WHEN rating IS NOT NULL THEN 1 ELSE 0 END) AS rated
         FROM temp.artwork_curation`
      )
      .get() ?? { highlighted: 0, rated: 0 };

  return {
    totalCatalogItems: db.totalCatalogItems,
    sourceCounts: db.sourceCounts,
    sources: db.sources,
    curation: {
      highlighted: curation.highlighted ?? 0,
      rated: curation.rated ?? 0,
    },
  };
}

export function findArtworkById(
  artworks: Artwork[],
  id: string,
  curation: Record<string, ArtworkCurationItem> = {}
) {
  const artwork = artworks.find((candidate) => candidate.id === id);
  return artwork ? toApiArtwork(artwork, curation[artwork.id]) : undefined;
}

export function toApiArtwork(
  artwork: Artwork,
  curationItem: ArtworkCurationItem = {}
): ArtworkApiItem {
  const resizedUrls: Record<string, string> = {};
  const selected = curationItem.highlighted === true;

  for (const [width, url] of Object.entries(
    artwork.image.localResizedPaths ?? {}
  )) {
    const assetUrl = toAssetUrl(url);
    if (assetUrl) resizedUrls[width] = assetUrl;
  }

  return {
    ...artwork,
    selected,
    highlighted: selected,
    rating: curationItem.rating,
    image: {
      ...artwork.image,
      url:
        toAssetUrl(
          artwork.image.localResizedPaths?.["512"] ??
            artwork.image.localResizedPaths?.["1024"] ??
            artwork.image.localOriginalPath
        ) ?? artwork.image.originalUrl,
      localOriginalPath: artwork.image.localOriginalPath
        ? toAssetUrl(artwork.image.localOriginalPath)
        : undefined,
      localResizedPaths:
        Object.keys(resizedUrls).length > 0 ? resizedUrls : undefined,
      resizedUrls: Object.keys(resizedUrls).length > 0 ? resizedUrls : undefined,
    },
  };
}

export function parseArtworkSearchParams(searchParams: URLSearchParams) {
  return {
    q: searchParams.get("q") ?? undefined,
    source: parseArtworkSource(searchParams.get("source")),
    publicDomain: parseBoolean(searchParams.get("publicDomain")),
    license: searchParams.get("license") ?? undefined,
    tag: searchParams.get("tag") ?? undefined,
    collection: searchParams.get("collection") ?? undefined,
    selected: parseBoolean(searchParams.get("selected")),
    highlighted: parseBoolean(searchParams.get("highlighted")),
    rating: parseRatingFilter(searchParams.get("rating")),
    limit: parsePositiveInt(searchParams.get("limit"), DEFAULT_LIMIT),
    offset: parseNonNegativeInt(searchParams.get("offset"), 0),
  } satisfies ArtworkSearchFilters;
}

export function isAuthorized(request: Request) {
  const apiKey = process.env.ART_API_KEY?.trim();
  if (!apiKey) return true;

  const authorization = request.headers.get("authorization");
  const bearerToken = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  const headerKey = request.headers.get("x-api-key");

  return bearerToken === apiKey || headerKey === apiKey;
}

export function corsHeaders(request: Request) {
  const origins = (process.env.ART_ALLOWED_ORIGINS ?? "*")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  const requestOrigin = request.headers.get("origin");
  const allowOrigin =
    origins.length === 0 || origins.includes("*") || !requestOrigin
      ? "*"
      : origins.includes(requestOrigin)
      ? requestOrigin
      : origins[0];

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-API-Key",
    "Cache-Control": "public, max-age=60, stale-while-revalidate=300",
    Vary: "Origin",
  };
}

function scoreArtwork(artwork: Artwork, queryTerms: string[]) {
  const title = normalizeText(artwork.title);
  const artist = normalizeText(artwork.artist);
  const source = normalizeText(artwork.source);
  const sourceId = normalizeText(artwork.sourceId);
  const license = normalizeText(artwork.license);
  const collection = normalizeText(artwork.collection?.name);
  const author = normalizeText(artwork.author?.name);
  const tags = (artwork.tags ?? []).map(normalizeText);
  const searchable = [
    title,
    artist,
    source,
    sourceId,
    license,
    collection,
    author,
    ...tags,
  ].join(" ");

  if (!queryTerms.every((term) => searchable.includes(term))) return 0;

  return queryTerms.reduce((score, term) => {
    if (title === term) return score + 100;
    if (title.startsWith(term)) return score + 80;
    if (title.includes(term)) return score + 60;
    if (tags.some((candidate) => candidate === term)) return score + 45;
    if (tags.some((candidate) => candidate.includes(term))) return score + 35;
    if (artist.includes(term) || author.includes(term)) return score + 25;
    if (collection.includes(term)) return score + 20;
    return score + 10;
  }, 0);
}

function compareDownloadedAt(a: Artwork, b: Artwork) {
  return (b.search?.downloadedAt ?? "").localeCompare(
    a.search?.downloadedAt ?? ""
  );
}

function getRatingSortValue(curationItem?: ArtworkCurationItem) {
  return typeof curationItem?.rating === "number" ? curationItem.rating : 0;
}

function toAssetUrl(value?: string) {
  if (!value) return undefined;
  if (/^https?:\/\//i.test(value)) return value;

  const baseUrl = process.env.ART_ASSET_BASE_URL?.trim();
  if (!baseUrl) return value;

  return `${baseUrl.replace(/\/+$/, "")}/${value.replace(/^\/+/, "")}`;
}

function normalizeText(value?: string) {
  return (value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function parseArtworkSource(value: string | null): ArtworkSource | undefined {
  if (
    value === "met" ||
    value === "artic" ||
    value === "svgrepo" ||
    value === "wikimedia"
  ) {
    return value;
  }
  return undefined;
}

function parseBoolean(value: string | null) {
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return undefined;
}

function parseRatingFilter(value: string | null) {
  if (value === "rated" || value === "unrated") return value;

  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 5) {
    return parsed as 1 | 2 | 3 | 4 | 5;
  }

  return undefined;
}

function parsePositiveInt(value: string | null | undefined, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.trunc(parsed);
}

function parseNonNegativeInt(value: string | null, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.trunc(parsed);
}

function clampLimit(value?: number) {
  return Math.min(MAX_LIMIT, Math.max(1, value ?? DEFAULT_LIMIT));
}

type ArtworkDatabase = NonNullable<typeof cachedArtworkDb>;

type ArtworkRow = {
  payloadJson: string;
  highlighted: number | null;
  rating: number | null;
};

type ArtworkSql = {
  ftsJoin: string;
  whereSql: string;
  params: Record<string, string | number>;
};

function getArtworkDatabase(): ArtworkDatabase {
  const dbPath = artworkDatabasePath();

  if (cachedArtworkDb?.db.open && cachedArtworkDb.dbPath === dbPath) {
    return cachedArtworkDb;
  }

  if (!fsSync.existsSync(dbPath)) {
    throw new Error(
      `Artwork SQLite catalog not found at ${dbPath}. Run npm run catalog:build.`
    );
  }

  const db = new Database(dbPath, {
    fileMustExist: true,
    readonly: true,
  });

  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TEMP TABLE IF NOT EXISTS artwork_curation (
      id TEXT PRIMARY KEY,
      highlighted INTEGER NOT NULL DEFAULT 0,
      rating INTEGER
    )
  `);

  const sourceRows = db
    .prepare<[], { source: ArtworkSource; count: number }>(
      `SELECT source, COUNT(*) AS count
       FROM artworks
       GROUP BY source
       ORDER BY source`
    )
    .all();
  const sourceCounts = Object.fromEntries(
    sourceRows.map((row) => [row.source, row.count])
  ) as Partial<Record<ArtworkSource, number>>;
  const totalCatalogItems =
    db.prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM artworks")
      .get()?.count ?? 0;

  cachedArtworkDb = {
    db,
    dbPath,
    sourceCounts,
    sources: sourceRows.map((row) => row.source),
    totalCatalogItems,
    curationStamp: "",
  };

  refreshCurationTable(cachedArtworkDb);
  return cachedArtworkDb;
}

function artworkDatabasePath() {
  return process.env.ARTWORK_DB_PATH?.trim()
    ? path.resolve(process.env.ARTWORK_DB_PATH)
    : path.join(process.cwd(), "data", "artworks.sqlite");
}

function refreshCurationTable(state: ArtworkDatabase) {
  const stamp = getCurationStamp();
  if (state.curationStamp === stamp) return;

  const curation = loadArtworkCurationSync();
  const insert = state.db.prepare<{
    id: string;
    highlighted: number;
    rating: number | null;
  }>(
    `INSERT INTO temp.artwork_curation (id, highlighted, rating)
     VALUES (@id, @highlighted, @rating)`
  );
  const replaceCuration = state.db.transaction(() => {
    state.db.exec("DELETE FROM temp.artwork_curation");

    for (const [id, item] of Object.entries(curation)) {
      insert.run({
        id,
        highlighted: item.highlighted === true ? 1 : 0,
        rating: item.rating ?? null,
      });
    }
  });

  replaceCuration();
  state.curationStamp = stamp;
}

function getCurationStamp() {
  try {
    const stat = fsSync.statSync(curationFilePath());
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return "missing";
  }
}

function buildArtworkSql(filters: ArtworkSearchFilters): ArtworkSql {
  const where: string[] = [];
  const params: Record<string, string | number> = {};
  const ftsQuery = toFtsQuery(filters.q);

  if (ftsQuery) {
    params.ftsQuery = ftsQuery;
    where.push("artwork_fts MATCH @ftsQuery");
  }

  if (filters.source) {
    params.source = filters.source;
    where.push("a.source = @source");
  }

  if (typeof filters.publicDomain === "boolean") {
    params.publicDomain = filters.publicDomain ? 1 : 0;
    where.push("a.is_public_domain = @publicDomain");
  }

  const license = normalizeText(filters.license);
  if (license) {
    params.license = `%${license}%`;
    where.push("a.license_normalized LIKE @license");
  }

  const tag = normalizeText(filters.tag);
  if (tag) {
    params.tag = `%${tag}%`;
    where.push(
      `EXISTS (
        SELECT 1
        FROM artwork_tags t
        WHERE t.artwork_id = a.id
          AND t.tag_normalized LIKE @tag
      )`
    );
  }

  const collection = normalizeText(filters.collection);
  if (collection) {
    params.collection = `%${collection}%`;
    where.push("a.collection_name_normalized LIKE @collection");
  }

  const selected =
    typeof filters.selected === "boolean"
      ? filters.selected
      : filters.highlighted;
  if (typeof selected === "boolean") {
    params.selected = selected ? 1 : 0;
    where.push("COALESCE(c.highlighted, 0) = @selected");
  }

  if (filters.rating === "rated") {
    where.push("c.rating IS NOT NULL");
  } else if (filters.rating === "unrated") {
    where.push("c.rating IS NULL");
  } else if (typeof filters.rating === "number") {
    params.rating = filters.rating;
    where.push("c.rating = @rating");
  }

  return {
    ftsJoin: ftsQuery
      ? "JOIN artwork_fts ON artwork_fts.rowid = a.search_rowid"
      : "",
    whereSql: where.length > 0 ? `WHERE ${where.join(" AND ")}` : "",
    params,
  };
}

function toFtsQuery(value?: string) {
  const terms = normalizeText(value).split(" ").filter(Boolean).slice(0, 12);
  if (terms.length === 0) return undefined;
  return terms.map((term) => `${term}*`).join(" ");
}

function rowToApiArtwork(row: ArtworkRow) {
  const artwork = JSON.parse(row.payloadJson) as Artwork;
  const curationItem: ArtworkCurationItem = {};

  if (row.highlighted === 1) curationItem.highlighted = true;
  if (
    typeof row.rating === "number" &&
    Number.isInteger(row.rating) &&
    row.rating >= 1 &&
    row.rating <= 5
  ) {
    curationItem.rating = row.rating as ArtworkCurationItem["rating"];
  }

  return toApiArtwork(artwork, curationItem);
}

async function fetchTextCatalog(url: string) {
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    next: { revalidate: 300 },
  });

  if (!response.ok) {
    throw new Error(`Catalog request failed: ${response.status}`);
  }

  return response.text();
}
