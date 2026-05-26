# paperlesspaper Art

Curated public-domain and Creative Commons artworks/icons for
[paperlesspaper.de](https://paperlesspaper.de). The catalog is generated
offline, uploaded to object storage, and exposed through a small read-only API
that paperlesspaper-web can search.

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
```

Query parameters:

- `q`: searches title, artist, author, collection, license, source, source id, and tags
- `source`: `met`, `artic`, `wikimedia`, or `svgrepo`
- `publicDomain`: `true` or `false`
- `license`: text filter on license
- `tag`: text filter on tags
- `collection`: text filter on collection name
- `limit`: defaults to `40`, max `200`
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
  "offset": 0
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
    "image": {
      "url": "https://fsn1.your-objectstorage.com/paperlesspaper-art/images/svgrepo/526478/original.svg"
    }
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

The web app also supports app-domain image URLs by redirecting them:

```txt
GET https://art.paperlesspaper.de/images/svgrepo/528659/original.svg
```

redirects to:

```txt
https://fsn1.your-objectstorage.com/paperlesspaper-art/images/svgrepo/528659/original.svg
```

This keeps URLs convenient without bundling hundreds of MB of image files into
the Dokploy container.

## Client Example

```ts
type ArtworkSearchResponse = {
  items: Artwork[];
  total: number;
  limit: number;
  offset: number;
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

## HTTP Behavior

- `GET /api/artworks` returns `200`.
- `GET /api/artworks/:id` returns `200` or `404`.
- If `ART_API_KEY` is configured, clients must pass either:
  - `Authorization: Bearer <key>`
  - `X-API-Key: <key>`
- CORS is controlled by `ART_ALLOWED_ORIGINS`.
- API responses use `Cache-Control: public, max-age=60, stale-while-revalidate=300`.
- The in-memory catalog cache is controlled by `ART_CATALOG_CACHE_TTL_MS`.

## Runtime Environment

Dokploy/web runtime:

```env
ART_CATALOG_URL=https://fsn1.your-objectstorage.com/paperlesspaper-art/artworks.json
ART_ASSET_BASE_URL=https://fsn1.your-objectstorage.com/paperlesspaper-art
ART_ALLOWED_ORIGINS=https://paperlesspaper.de,https://app.paperlesspaper.de
ART_CATALOG_CACHE_TTL_MS=300000
ART_API_KEY=
```

Local/CI sync environment:

```env
S3_BUCKET=paperlesspaper-art
S3_ENDPOINT=https://fsn1.your-objectstorage.com
S3_REGION=fsn1
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
```

Do not put `AWS_ACCESS_KEY_ID` or `AWS_SECRET_ACCESS_KEY` into Dokploy unless the
server is also responsible for uploading assets. In the normal setup, Dokploy
only reads public catalog/assets.

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
yarn install
yarn build

node dist/index.js met --query "landscape" --limit 100
node dist/index.js artic --query "portrait" --limit 100
node dist/index.js wikimedia --query "paintings" --limit 100
node dist/index.js svgrepo --query "cat" --limit 100
```

Publish to object storage:

```bash
set -a
source .env
set +a

aws s3 sync apps/web/public/images s3://$S3_BUCKET/images --delete --only-show-errors --endpoint-url $S3_ENDPOINT
aws s3 cp apps/web/data/artworks.json s3://$S3_BUCKET/artworks.json --only-show-errors --endpoint-url $S3_ENDPOINT
```

The API picks up the new catalog after `ART_CATALOG_CACHE_TTL_MS`, or immediately
after restarting the Dokploy app.

## Repository Layout

- `apps/web`: Next.js web/API app
- `apps/web/data/artworks.json`: generated catalog metadata
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
