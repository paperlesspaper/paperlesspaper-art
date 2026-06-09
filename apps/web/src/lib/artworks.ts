import {
  ensureArtworkDatabase,
  getArtworkPool,
  type QueryParam,
} from "@/lib/artwork-database";
import type { ArtworkCurationItem } from "@/lib/artwork-curation";

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
  sort?: ArtworkSort;
  limit?: number;
  offset?: number;
};

export type ArtworkSort =
  | "curated"
  | "relevance"
  | "title-asc"
  | "title-desc"
  | "date-desc"
  | "date-asc"
  | "downloaded-desc"
  | "downloaded-asc"
  | "rating-desc"
  | "rating-asc";

export type ArtworkCatalogMeta = {
  totalCatalogItems: number;
  sourceCounts: Partial<Record<ArtworkSource, number>>;
  sources: ArtworkSource[];
  tags: ArtworkTagCloudItem[];
  topicClouds: {
    art: ArtworkTagCloudItem[];
    svg: ArtworkTagCloudItem[];
  };
  curation: {
    highlighted: number;
    rated: number;
  };
};

export type ArtworkTagCloudItem = {
  tag: string;
  count: number;
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
const DEFAULT_SORT: ArtworkSort = "curated";
const HIDDEN_PRODUCTION_RATING = 1;

export async function searchArtworkCatalog(
  filters: ArtworkSearchFilters
): Promise<ArtworkCatalogSearchResult> {
  await ensureArtworkDatabase();

  const limit = clampLimit(filters.limit);
  const offset = Math.max(0, filters.offset ?? 0);
  const query = buildArtworkSql(filters);

  const total =
    (
      await getArtworkPool().query<{ total: string }>(
        `SELECT COUNT(*) AS total
         FROM artworks a
         LEFT JOIN artwork_curation c ON c.id = a.id
         ${query.whereSql}`,
        query.params
      )
    ).rows[0]?.total ?? "0";

  const selectParams = [...query.params, limit, offset];
  const rows = (
    await getArtworkPool().query<ArtworkRow>(
      `SELECT
          a.payload_json AS "payloadJson",
          COALESCE(c.highlighted, FALSE) AS highlighted,
          c.rating AS rating,
          ${query.rankSql} AS search_rank
       FROM artworks a
       LEFT JOIN artwork_curation c ON c.id = a.id
       ${query.whereSql}
       ORDER BY ${query.orderSql}
       LIMIT $${selectParams.length - 1} OFFSET $${selectParams.length}`,
      selectParams
    )
  ).rows;

  return {
    items: rows.map(rowToApiArtwork),
    total: Number(total),
    limit,
    offset,
    meta: await getArtworkCatalogMeta(),
  };
}

export async function findArtworkInCatalogById(id: string) {
  await ensureArtworkDatabase();

  const productionRatingFilter = shouldHideOneStarArtworks()
    ? ` AND c.rating IS DISTINCT FROM ${HIDDEN_PRODUCTION_RATING}`
    : "";
  const row = (
    await getArtworkPool().query<ArtworkRow>(
      `SELECT
          a.payload_json AS "payloadJson",
          COALESCE(c.highlighted, FALSE) AS highlighted,
          c.rating AS rating
       FROM artworks a
       LEFT JOIN artwork_curation c ON c.id = a.id
       WHERE a.id = $1${productionRatingFilter}
       LIMIT 1`,
      [id]
    )
  ).rows[0];

  return row ? rowToApiArtwork(row) : undefined;
}

export async function getArtworkCatalogMeta(): Promise<ArtworkCatalogMeta> {
  await ensureArtworkDatabase();

  const [sourceRows, totalRow, curationRow, artTopicRows, svgTopicRows] =
    await Promise.all([
    getArtworkPool().query<{ source: ArtworkSource; count: string }>(
      `SELECT source, COUNT(*) AS count
       FROM artworks
       GROUP BY source
       ORDER BY source`
    ),
    getArtworkPool().query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM artworks"
    ),
    getArtworkPool().query<{ highlighted: string; rated: string }>(
      `SELECT
          COUNT(*) FILTER (WHERE highlighted = TRUE) AS highlighted,
          COUNT(*) FILTER (WHERE rating IS NOT NULL) AS rated
       FROM artwork_curation`
    ),
    getArtworkTopicRows("wikimedia"),
    getArtworkTopicRows("svgrepo"),
  ]);

  const sourceCounts = Object.fromEntries(
    sourceRows.rows.map((row) => [row.source, Number(row.count)])
  ) as Partial<Record<ArtworkSource, number>>;
  const curation = curationRow.rows[0] ?? { highlighted: "0", rated: "0" };
  const artTopics = buildTopicCloud(artTopicRows.rows);
  const svgTopics = buildTopicCloud(svgTopicRows.rows);

  return {
    totalCatalogItems: Number(totalRow.rows[0]?.count ?? 0),
    sourceCounts,
    sources: sourceRows.rows.map((row) => row.source),
    tags: [...artTopics, ...svgTopics]
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
      .slice(0, 48),
    topicClouds: {
      art: artTopics,
      svg: svgTopics,
    },
    curation: {
      highlighted: Number(curation.highlighted ?? 0),
      rated: Number(curation.rated ?? 0),
    },
  };
}

async function getArtworkTopicRows(source: ArtworkSource) {
  const hiddenRating = shouldHideOneStarArtworks()
    ? HIDDEN_PRODUCTION_RATING
    : null;

  return getArtworkPool().query<{ value: string | null; count: string }>(
    `SELECT value, COUNT(DISTINCT artwork_id) AS count
     FROM (
       SELECT a.id AS artwork_id, a.collection_name AS value
       FROM artworks a
       LEFT JOIN artwork_curation c ON c.id = a.id
       WHERE a.source = $1
         AND a.collection_name IS NOT NULL
         AND a.collection_name_normalized <> ''
         AND ($2::integer IS NULL OR c.rating IS DISTINCT FROM $2)

       UNION ALL

       SELECT a.id AS artwork_id, a.search_query AS value
       FROM artworks a
       LEFT JOIN artwork_curation c ON c.id = a.id
       WHERE a.source = $1
         AND a.search_query IS NOT NULL
         AND btrim(a.search_query) <> ''
         AND ($2::integer IS NULL OR c.rating IS DISTINCT FROM $2)
     ) topic_candidates
     GROUP BY value
     ORDER BY count DESC, value ASC
     LIMIT 300`,
    [source, hiddenRating]
  );
}

function buildTopicCloud(
  rows: Array<{ value: string | null; count: string }>
): ArtworkTagCloudItem[] {
  const topics = new Map<string, ArtworkTagCloudItem>();

  for (const row of rows) {
    const tag = toTopicLabel(row.value);
    if (!tag) continue;

    const key = normalizeText(tag);
    if (!key || isNoisyTopic(key)) continue;

    const count = Number(row.count);
    if (!Number.isFinite(count) || count <= 0) continue;

    const current = topics.get(key);
    if (!current) {
      topics.set(key, { tag, count });
      continue;
    }

    topics.set(key, {
      tag: chooseTopicLabel(current.tag, tag),
      count: Math.max(current.count, count),
    });
  }

  return Array.from(topics.values())
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
    .slice(0, 48);
}

function toTopicLabel(value: string | null) {
  const source = extractTopicSource(value);
  const cleaned = source
    .replace(/^collection:/i, "")
    .replace(/[_+/.-]+/g, " ")
    .replace(/\bgoogle\s+art\s+project\b/gi, " ")
    .replace(/\bwikimedia\s+commons\b/gi, " ")
    .replace(/\bpublic\s+domain\b/gi, " ")
    .replace(/\b(svg|vector|vectors|icon|icons|batch)\b/gi, " ")
    .replace(
      /\b(artwork|bold|broken|category|cfpb|chunk|clarity|collection|color|colored|dark|dazzle|design\s+system|duotone|eink|evericons|fill|filled|flat|forge|glyph|icooon|iconcino|interface|kalai|light|line|linea|metriz|minimal|modern|mono|moon|mt\s+web|olicons|oval|outline|outlined|pack|paintings|puppylinux|sepia|set|sign|simple|solid|solar|sensa|system|thick|thin|ui|variety|various|v[0-9]+)\b/gi,
      " "
    )
    .replace(/\b[0-9]+px\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) return undefined;
  return titleCaseTopic(cleaned);
}

function extractTopicSource(value: string | null) {
  let text = (value ?? "").trim();
  const collectionMatch = text.match(/svgrepo\.com\/collection\/([^/?#]+)/i);
  if (collectionMatch?.[1]) {
    text = collectionMatch[1];
  }

  const categoryIndex = text.toLowerCase().lastIndexOf("category:");
  if (categoryIndex >= 0) {
    text = text.slice(categoryIndex + "category:".length);
  }

  const colonIndex = text.lastIndexOf(":");
  if (colonIndex >= 0 && colonIndex < text.length - 1) {
    text = text.slice(colonIndex + 1);
  }

  return text;
}

function titleCaseTopic(value: string) {
  return value
    .split(" ")
    .map((word) => {
      if (/^(ai|api|ui|ux|url|pdf|png|jpg|qr|tv)$/i.test(word)) {
        return word.toUpperCase();
      }
      if (/^3d$/i.test(word)) return "3D";
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(" ");
}

function chooseTopicLabel(current: string, next: string) {
  if (next.length < current.length) return next;
  if (next.length === current.length && next.localeCompare(current) < 0) {
    return next;
  }
  return current;
}

function isNoisyTopic(normalized: string) {
  const words = normalized.split(" ").filter(Boolean);
  const exactNoisyTopics = new Set([
    "afiado sharp pixel",
    "and symbols",
    "asoka",
    "art",
    "bordered",
    "bowtie",
    "brankic",
    "collection",
    "cornered",
    "dedupe title hash",
    "design",
    "doodle",
    "ficons",
    "foundation",
    "futicons futuristic",
    "google art project",
    "icona",
    "maki",
    "metriz circled",
    "metrize circled",
    "moriarty",
    "online",
    "open web",
    "other",
    "paintings",
    "pixeden",
    "poster",
    "sargam",
    "small",
    "start universal tiny",
    "super basic",
    "svg",
    "svgrepo",
    "symbols",
    "system",
    "typicons",
    "ui",
    "wave",
    "wikimedia art",
    "zondicons",
  ]);
  const noisyWords = new Set([
    "arrow",
    "batch",
    "dedupe",
    "file",
    "folder",
    "hash",
    "icon",
    "icons",
    "svg",
    "vector",
    "vectors",
  ]);

  return (
    normalized.length < 3 ||
    exactNoisyTopics.has(normalized) ||
    words.some((word) => noisyWords.has(word))
  );
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
    sort: parseArtworkSort(searchParams.get("sort")),
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
    "Cache-Control": "no-store, max-age=0",
    Vary: "Origin",
  };
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

function parseArtworkSort(value: string | null): ArtworkSort | undefined {
  if (
    value === "curated" ||
    value === "relevance" ||
    value === "title-asc" ||
    value === "title-desc" ||
    value === "date-desc" ||
    value === "date-asc" ||
    value === "downloaded-desc" ||
    value === "downloaded-asc" ||
    value === "rating-desc" ||
    value === "rating-asc"
  ) {
    return value;
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

type ArtworkRow = {
  payloadJson: Artwork | string;
  highlighted: boolean | null;
  rating: number | null;
};

type ArtworkSql = {
  rankSql: string;
  orderSql: string;
  whereSql: string;
  params: QueryParam[];
};

function buildArtworkSql(filters: ArtworkSearchFilters): ArtworkSql {
  const where: string[] = [];
  const params: QueryParam[] = [];
  const ftsQuery = toPostgresTsQuery(filters.q);
  let rankSql = "0";

  const addParam = (value: QueryParam) => {
    params.push(value);
    return `$${params.length}`;
  };

  if (ftsQuery) {
    const placeholder = addParam(ftsQuery);
    const tsQuery = `to_tsquery('simple', ${placeholder})`;
    where.push(`a.search_vector @@ ${tsQuery}`);
    rankSql = `ts_rank_cd(a.search_vector, ${tsQuery})`;
  }

  if (filters.source) {
    where.push(`a.source = ${addParam(filters.source)}`);
  }

  if (typeof filters.publicDomain === "boolean") {
    where.push(`a.is_public_domain = ${addParam(filters.publicDomain)}`);
  }

  const license = normalizeText(filters.license);
  if (license) {
    where.push(`a.license_normalized LIKE ${addParam(`%${license}%`)}`);
  }

  const tag = normalizeText(filters.tag);
  if (tag) {
    const tagPlaceholder = addParam(`%${tag}%`);
    where.push(
      `(
        a.collection_name_normalized LIKE ${tagPlaceholder}
        OR regexp_replace(lower(COALESCE(a.search_query, '')), '[^a-z0-9]+', ' ', 'g') LIKE ${tagPlaceholder}
        OR EXISTS (
          SELECT 1
          FROM artwork_tags t
          WHERE t.artwork_id = a.id
            AND t.tag_normalized LIKE ${tagPlaceholder}
        )
      )`
    );
  }

  const collection = normalizeText(filters.collection);
  if (collection) {
    where.push(
      `a.collection_name_normalized LIKE ${addParam(`%${collection}%`)}`
    );
  }

  const selected =
    typeof filters.selected === "boolean"
      ? filters.selected
      : filters.highlighted;
  if (typeof selected === "boolean") {
    where.push(`COALESCE(c.highlighted, FALSE) = ${addParam(selected)}`);
  }

  if (filters.rating === "rated") {
    where.push("c.rating IS NOT NULL");
  } else if (filters.rating === "unrated") {
    where.push("c.rating IS NULL");
  } else if (typeof filters.rating === "number") {
    where.push(`c.rating = ${addParam(filters.rating)}`);
  }

  if (shouldHideOneStarArtworks()) {
    where.push(`c.rating IS DISTINCT FROM ${HIDDEN_PRODUCTION_RATING}`);
  }

  return {
    rankSql,
    orderSql: buildArtworkOrderSql(
      filters.sort ?? DEFAULT_SORT,
      Boolean(ftsQuery)
    ),
    whereSql: where.length > 0 ? `WHERE ${where.join(" AND ")}` : "",
    params,
  };
}

function buildArtworkOrderSql(sort: ArtworkSort, hasQuery: boolean) {
  const relevanceOrder = hasQuery ? "search_rank DESC" : "";
  const ratingDesc = "COALESCE(c.rating, 0) DESC";
  const ratingAsc = "COALESCE(c.rating, 0) ASC";
  const titleAsc = "LOWER(a.title) ASC";
  const titleDesc = "LOWER(a.title) DESC";
  const downloadedDesc = "a.downloaded_at DESC";
  const downloadedAsc = "a.downloaded_at ASC";
  const fallbackDateYear = `NULLIF(
    substring(a.date FROM '(-?[0-9]{1,4})'),
    ''
  )::integer`;
  const dateYear = `COALESCE(
    NULLIF(
      substring(a.date FROM '([+-][0-9]{1,6})-[0-9]{2}-[0-9]{2}T'),
      ''
    )::integer,
    CASE
      WHEN a.date ~* '(b\\.?\\s*c\\.?|bce)' THEN -ABS(${fallbackDateYear})
      ELSE ${fallbackDateYear}
    END
  )`;

  switch (sort) {
    case "relevance":
      return orderClauses(
        relevanceOrder,
        ratingDesc,
        titleAsc,
        downloadedDesc,
        "a.id ASC"
      );
    case "title-asc":
      return orderClauses(titleAsc, relevanceOrder, downloadedDesc, "a.id ASC");
    case "title-desc":
      return orderClauses(
        titleDesc,
        relevanceOrder,
        downloadedDesc,
        "a.id ASC"
      );
    case "date-desc":
      return orderClauses(
        `${dateYear} DESC NULLS LAST`,
        relevanceOrder,
        titleAsc,
        downloadedDesc,
        "a.id ASC"
      );
    case "date-asc":
      return orderClauses(
        `${dateYear} ASC NULLS LAST`,
        relevanceOrder,
        titleAsc,
        downloadedDesc,
        "a.id ASC"
      );
    case "downloaded-desc":
      return orderClauses(
        downloadedDesc,
        relevanceOrder,
        titleAsc,
        "a.id ASC"
      );
    case "downloaded-asc":
      return orderClauses(
        `${downloadedAsc} NULLS LAST`,
        relevanceOrder,
        titleAsc,
        "a.id ASC"
      );
    case "rating-desc":
      return orderClauses(
        ratingDesc,
        relevanceOrder,
        titleAsc,
        downloadedDesc,
        "a.id ASC"
      );
    case "rating-asc":
      return orderClauses(
        ratingAsc,
        relevanceOrder,
        titleAsc,
        downloadedDesc,
        "a.id ASC"
      );
    case "curated":
    default:
      return orderClauses(
        ratingDesc,
        relevanceOrder,
        titleAsc,
        downloadedDesc,
        "a.id ASC"
      );
  }
}

function orderClauses(...clauses: string[]) {
  return clauses.filter(Boolean).join(", ");
}

function toPostgresTsQuery(value?: string) {
  const terms = normalizeText(value).split(" ").filter(Boolean).slice(0, 12);
  if (terms.length === 0) return undefined;
  return terms.map((term) => `${term}:*`).join(" & ");
}

function shouldHideOneStarArtworks() {
  return process.env.NODE_ENV === "production";
}

function rowToApiArtwork(row: ArtworkRow) {
  const artwork =
    typeof row.payloadJson === "string"
      ? (JSON.parse(row.payloadJson) as Artwork)
      : row.payloadJson;
  const curationItem: ArtworkCurationItem = {};

  if (row.highlighted === true) curationItem.highlighted = true;
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
