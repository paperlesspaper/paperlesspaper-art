# paperlesspaper Art

![paperlesspaper Art hero](assets/readme-hero.png)

Curated public-domain and Creative Commons artworks/icons for
[paperlesspaper.de](https://paperlesspaper.de). The catalog is generated
offline, uploaded to object storage, and exposed through a small read-only API
that paperlesspaper-web can search.

## Support Open Source

paperlesspaper.de is built to make everyday paperwork simpler, calmer, and more
accessible. If this catalog is useful to your project, support the open-source
work behind it by visiting [paperlesspaper.de](https://paperlesspaper.de) and
sharing it with people who could use better digital documents.

## Integration Reference

Production base URL:

```txt
https://art.paperlesspaper.de
```

Object storage asset base:

```txt
https://fsn1.your-objectstorage.com/paperlesspaper-art
```

paperlesspaper-web should call the API on `art.paperlesspaper.de` and render the
returned `image.url`.

## Search API

```txt
GET /api/artworks
```

Example:

```txt
GET https://art.paperlesspaper.de/api/artworks?q=bell&source=svgrepo&limit=10
GET https://art.paperlesspaper.de/api/artworks?selected=true&rating=5
```

Query parameters:

- `q`: searches title, artist, author, collection, license, source, source id, and tags
- `source`: `met`, `artic`, `wikimedia`, or `svgrepo`
- `publicDomain`: `true` or `false`
- `license`: text filter on license
- `tag`: text filter on tags
- `collection`: text filter on collection name
- `selected`: `true` or `false`, filters by the curation checkbox state
- `highlighted`: alias for `selected`
- `rating`: `1`, `2`, `3`, `4`, `5`, `rated`, or `unrated`
- `sort`: `curated`, `relevance`, `title-asc`, `title-desc`, `date-desc`,
  `date-asc`, `downloaded-desc`, `downloaded-asc`, `rating-desc`, or
  `rating-asc`
- `limit`: defaults to `100`, max `200`
- `offset`: pagination offset

Response shape:

```json
{
  "items": [
    {
      "id": "svgrepo:526478",
      "source": "svgrepo",
      "sourceId": "526478",
      "title": "Bell bing SVG Vector",
      "artist": "Solar Icons",
      "isPublicDomain": false,
      "license": "CC Attribution License",
      "licenseUrl": "https://www.svgrepo.com/page/licensing/#CC%20Attribution",
      "sourceUrl": "https://www.svgrepo.com/svg/526478/bell-bing",
      "selected": true,
      "highlighted": true,
      "rating": 5,
      "collection": {
        "name": "Solar Line Duotone Icons",
        "url": "https://www.svgrepo.com/collection/solar-line-duotone-icons/"
      },
      "author": {
        "name": "Solar Icons",
        "url": "https://www.figma.com/community/file/1166831539721848736"
      },
      "tags": ["Bell bing", "Bell Canada"],
      "image": {
        "originalUrl": "https://www.svgrepo.com/download/526478/bell-bing.svg",
        "width": 800,
        "height": 800,
        "url": "https://fsn1.your-objectstorage.com/paperlesspaper-art/images/svgrepo/526478/original.svg",
        "localOriginalPath": "https://fsn1.your-objectstorage.com/paperlesspaper-art/images/svgrepo/526478/original.svg"
      },
      "search": {
        "query": "collection:solar-line-duotone-icons",
        "downloadedAt": "2026-01-07T16:58:51.123Z"
      }
    }
  ],
  "total": 45,
  "limit": 10,
  "offset": 0,
  "meta": {
    "totalCatalogItems": 12000,
    "sourceCounts": {
      "svgrepo": 9000,
      "wikimedia": 3000
    },
    "sources": ["svgrepo", "wikimedia"],
    "curation": {
      "highlighted": 42,
      "rated": 120
    }
  }
}
```

## Detail API

```txt
GET /api/artworks/:id
```

IDs contain `:`, so URL-encode them:

```txt
GET https://art.paperlesspaper.de/api/artworks/svgrepo%3A526478
```

Response shape:

```json
{
  "item": {
    "id": "svgrepo:526478",
    "title": "Bell bing SVG Vector",
    "source": "svgrepo",
    "selected": true,
    "highlighted": true,
    "rating": 5,
    "image": {
      "width": 800,
      "height": 800,
      "url": "https://fsn1.your-objectstorage.com/paperlesspaper-art/images/svgrepo/526478/original.svg"
    }
  }
}
```

## Curation UI And API

The gallery page includes a lightweight curation tool for reviewing the local
catalog:

- Search by title, artist, tag, collection, license, source, or source id.
- Filter by source, selected/highlighted state, and rating.
- Toggle the checkbox on each card to mark an artwork as selected/highlighted.
- Set a rating from `1` to `5`; click the active rating again to clear it.

Curation is stored in the Postgres `artwork_curation` table, keyed by artwork
id:

```json
{
  "wikimedia:21856227": {
    "highlighted": true,
    "rating": 5
  }
}
```

Local JSON files are not used by the web runtime.

The public artwork APIs hydrate this state onto each returned item as
`selected`, `highlighted`, and `rating`. `selected` and `highlighted` currently
represent the same checkbox state; `selected` is the consumer-facing field.

The curation map can also be read or updated through:

```txt
GET /api/curation
PATCH /api/curation
```

Patch body:

```json
{
  "id": "wikimedia:21856227",
  "highlighted": true,
  "rating": 5
}
```

Use `"rating": null` to clear a rating, and `"highlighted": false` to clear the
selected/highlighted state.

Patch response:

```json
{
  "id": "wikimedia:21856227",
  "item": {
    "highlighted": true,
    "rating": 5
  }
}
```

## Image URLs

The canonical image URL for consumers is:

```txt
item.image.url
```

The API rewrites local catalog paths like:

```txt
/images/svgrepo/526478/original.svg
```

to object-storage URLs using `ART_ASSET_BASE_URL`.

The web app also supports app-domain image URLs by proxying them:

```txt
GET https://art.paperlesspaper.de/images/svgrepo/528659/original.svg
```

streams the object-storage asset from:

```txt
https://fsn1.your-objectstorage.com/paperlesspaper-art/images/svgrepo/528659/original.svg
```

This keeps URLs convenient, adds CORS headers for canvas/Fabric.js use cases,
and avoids exposing object-storage CORS as a client dependency.

## Client Example

```ts
type ArtworkSearchResponse = {
  items: Artwork[];
  total: number;
  limit: number;
  offset: number;
  meta: {
    totalCatalogItems: number;
    sourceCounts: Partial<Record<Artwork["source"], number>>;
    sources: Artwork["source"][];
    curation: {
      highlighted: number;
      rated: number;
    };
  };
};

type Artwork = {
  id: string;
  source: "met" | "artic" | "wikimedia" | "svgrepo";
  sourceId: string;
  title: string;
  artist?: string;
  date?: string;
  isPublicDomain: boolean;
  license: string;
  licenseUrl?: string;
  sourceUrl: string;
  selected: boolean;
  highlighted: boolean;
  rating?: 1 | 2 | 3 | 4 | 5;
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
    url: string;
    localOriginalPath?: string;
    localResizedPaths?: Record<string, string>;
    resizedUrls?: Record<string, string>;
  };
};

export async function searchPaperlesspaperArt(params: {
  q?: string;
  source?: Artwork["source"];
  limit?: number;
  offset?: number;
}) {
  const url = new URL("https://art.paperlesspaper.de/api/artworks");

  if (params.q) url.searchParams.set("q", params.q);
  if (params.source) url.searchParams.set("source", params.source);
  if (params.limit) url.searchParams.set("limit", String(params.limit));
  if (params.offset) url.searchParams.set("offset", String(params.offset));

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Artwork search failed: ${response.status}`);
  }

  return (await response.json()) as ArtworkSearchResponse;
}
```

Recommended UI behavior for paperlesspaper-web:

- Use `item.image.url` for preview/render/import.
- Display `item.title`, `item.artist`, `item.license`, and `item.source`.
- Keep `item.sourceUrl` and `item.licenseUrl` available for attribution/details.
- Use `limit` and `offset` for pagination or infinite scroll.
- Prefer `source=svgrepo` when the user searches for icons.
- Prefer `publicDomain=true` when the target workflow requires public-domain only.
- Prefer `selected=true` or `rating=5` when surfacing curated picks.

## HTTP Behavior

- `GET /api/artworks` returns `200`.
- `GET /api/artworks/:id` returns `200` or `404`.
- `GET /api/curation` returns the raw curation map.
- `PATCH /api/curation` updates one curation entry and is only available from a local development host.
- If `ART_API_KEY` is configured, clients must pass either:
  - `Authorization: Bearer <key>`
  - `X-API-Key: <key>`
- CORS is controlled by `ART_ALLOWED_ORIGINS`.
- Artwork and curation API responses use `Cache-Control: no-store, max-age=0`.

## Runtime Environment

Dokploy/web runtime:

```env
DATABASE_URL=postgres://...
ART_ASSET_BASE_URL=https://fsn1.your-objectstorage.com/paperlesspaper-art
ART_ALLOWED_ORIGINS=https://paperlesspaper.de,https://app.paperlesspaper.de
ART_API_KEY=
```

Local/CI sync environment:

```env
DATABASE_URL=postgres://...
S3_BUCKET=paperlesspaper-art
S3_ENDPOINT=https://fsn1.your-objectstorage.com
S3_REGION=fsn1
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
```

Do not put `AWS_ACCESS_KEY_ID` or `AWS_SECRET_ACCESS_KEY` into Dokploy unless the
server is also responsible for uploading assets. In the normal setup, Dokploy
reads catalog and curation data from Postgres and public assets from object
storage.

## Hosting With Dokploy

Deploy this repo as a Dockerfile application.

Dokploy settings:

- Build context: `.`
- Dockerfile path: `Dockerfile`
- Container port: `3000`
- Domain: `art.paperlesspaper.de`
- HTTPS: enabled

The Docker image runs the Next standalone server and does not include
`apps/web/public/images`. Images are served from object storage.

## Updating The Catalog

The scraper is an offline content pipeline. Do not run it inside API request
handlers.

Generate/update locally or in CI:

```bash
cd packages/scraper
npm ci
npm run build

node dist/index.js met --query "landscape" --limit 100
node dist/index.js artic --query "portrait" --limit 100
node dist/index.js wikimedia --query "paintings" --limit 100
node dist/index.js wikimedia --query "paintings" --limit 100 --min-global-usage 5 --min-local-usage 2 --thumb-width 1024 --download-delay-ms 1000
node dist/index.js svgrepo --query "cat" --limit 100
```

If a non-interactive shell cannot find `node`, use the absolute Node binary, for
example `/usr/local/bin/node dist/index.js wikimedia --query "paintings" --limit
100`, or export a PATH that includes your Node install.

The scraper writes catalog metadata directly to Postgres and requires
`DATABASE_URL` or `POSTGRES_URL`. It writes downloaded assets to
`apps/web/public/images` by default. Use `--web-root` for the compiled CLI, or
`ARTWORK_IMAGES_ROOT` for scripts, when running outside the repo layout.
Scraper database helpers load environment values from the repo-root `.env`,
then `apps/web/.env.local`, then `apps/web/.env`; already-exported shell values
take precedence.
All scraper commands skip artwork IDs that already exist in Postgres before
downloading assets. Pass `--refresh-existing` to intentionally redownload and
update existing catalog rows.

### Wikimedia Search Loop

To keep rerunning the finite Wikimedia search scraper, use:

```bash
cd packages/scraper
npm ci
npm run build

QUERY=paintings \
LIMIT=100 \
MIN_GLOBAL_USAGE=5 \
MIN_LOCAL_USAGE=2 \
THUMB_WIDTH=1024 \
DOWNLOAD_DELAY_MS=5000 \
WIKIMEDIA_USER_AGENT="paperlesspaper-art/0.1 (https://github.com/paperlesspaper/paperlesspaper-art; you@example.com)" \
bash scripts/scrape-wikimedia-loop.sh
```

This loops the equivalent of:

```bash
node dist/index.js wikimedia --query "paintings" --limit 100 --min-global-usage 5 --min-local-usage 2 --thumb-width 1024 --download-delay-ms 5000
```

Useful environment variables:

- `QUERY`: Wikimedia search query, default `paintings`
- `LIMIT`: results per run, default `100`
- `WIDTHS`: resized image widths, default `512,1024`
- `MIN_GLOBAL_USAGE`: minimum global Wikimedia usage count, default `0`
- `MIN_LOCAL_USAGE`: minimum local Commons usage count, default `0`
- `THUMB_WIDTH`: Wikimedia thumbnail width to request, default `1024`
- `DOWNLOAD_DELAY_MS`: delay between image downloads, default `5000`
- `WIKIMEDIA_USER_AGENT`: descriptive Wikimedia request User-Agent with contact
  info; strongly recommended for long-running Commons scraping
- `WIKIMEDIA_MAXLAG`: Commons Action API `maxlag` value, default `5`; set `0`
  to omit it
- `SEARCH_OFFSET`: initial Wikimedia search offset, default `0` or the saved
  offset file value
- `OFFSET_FILE`: file used to persist the next search offset, default
  `.wikimedia-search-offset`
- `REFRESH_EXISTING`: redownload artwork IDs already in Postgres, default `0`
- `WEB_ROOT`: optional path to `apps/web`
- `NODE_BIN`: Node executable, default `node`
- `SUCCESS_DELAY`: delay before the next run after success, default `60`
- `RESTART_DELAY`: delay after a failed run, default `10`
- `MAX_FAILURES`: stop after this many failures; `0` means retry forever

The loop persists the next Wikimedia search offset in `OFFSET_FILE` and advances
by `LIMIT` after each successful run, so later runs continue through the search
results instead of reprocessing only the first page. For a broader Wikimedia
backfill that actively hunts for Google Art Project images across categories,
use the Google Art Project continuous scraper below.

For large Wikimedia runs, set `WIKIMEDIA_USER_AGENT` to identify your scraper
with a contact URL or email. If Wikimedia reports `HTTP 429 Too many requests`
or `HTTP 503 Service Unavailable`, the scraper now retries with backoff and
honors the `Retry-After` response header when Wikimedia sends one. If throttling
continues, lower `LIMIT`, temporarily lower `THUMB_WIDTH`, increase
`DOWNLOAD_DELAY_MS`, increase `SUCCESS_DELAY`/`RESTART_DELAY`, and let the client
cool down before retrying. The scraper logs per-run skip stats so you can see
whether candidates were filtered out or downloads were throttled.

### Google Art Project Continuous Scraper

For long-running Wikimedia/Google Art Project backfills, use the dedicated loop
script:

```bash
cd packages/scraper
npm ci

TARGET=1000 \
CONCURRENCY=10 \
bash scripts/download-google-art-project-loop.sh
```

The loop runs `scripts/download-google-art-project.mjs`, then restarts it until
you stop it with `Ctrl-C`.

Useful environment variables:

- `TARGET`: items to add per run, default `1000`
- `PER_SOURCE_CAP`: max items per category/search source per run, defaults to
  `TARGET`
- `CATEGORY_LIMIT`: max Wikimedia category members to inspect, default `50000`
- `SEARCH_LIMIT`: max Wikimedia search results to inspect, default `500`
- `CONCURRENCY`: parallel page workers, default `10`
- `WIDTHS`: resized image widths, default `512,1024`
- `THUMB_WIDTH`: Wikimedia thumbnail width to download, default `3840`
- `ARTWORK_IMAGES_ROOT`: override the local image output directory
- `SUCCESS_DELAY`: delay before the next run after success, default `5`
- `EMPTY_DELAY`: delay after a run adds no new items, default `300`
- `RESTART_DELAY`: delay after a failed run, default `10`
- `MAX_FAILURES`: stop after this many failures; `0` means retry forever
- `STOP_ON_EMPTY`: defaults to `1` in the loop, causing empty runs to exit with
  status `20` so the loop can wait longer before retrying

Publish generated images to object storage:

```bash
cd ../..
set -a
source .env
set +a

aws s3 sync apps/web/public/images s3://$S3_BUCKET/images --delete --only-show-errors --endpoint-url $S3_ENDPOINT
```

The web API reads the catalog directly from the Postgres `artworks` and
`artwork_tags` tables; static catalog JSON files are not part of the runtime or
Docker image.

## Repository Layout

- `apps/web`: Next.js web/API app
- Postgres `artworks`, `artwork_tags`, and `artwork_curation` tables: runtime catalog and curation data
- `apps/web/public/images`: generated local images, ignored by git and Docker
- `packages/scraper`: Node.js CLI for downloading and resizing assets

## Scraper Sources

- The Metropolitan Museum of Art Collection API: https://metmuseum.github.io/
- Art Institute of Chicago API: https://api.artic.edu/docs/
- Wikimedia Commons API: https://www.mediawiki.org/wiki/API:Main_page
- SVG Repo: https://www.svgrepo.com/

For `svgrepo`, you can optionally connect to an already-running Chrome session:

```bash
node dist/index.js svgrepo --all-collections --collections-start 0 --per-collection-limit 100000 --api-prefer --cdp-url http://127.0.0.1:9222
```
