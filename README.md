# paperlesspaper Art

Purpose: Provide a curated set of [Public Domain](https://en.wikipedia.org/wiki/Public_domain) and [Creative Commons](https://creativecommons.org/licenses/) artworks and icons for the [paperlesspaper.de](https://paperlesspaper.de) eInk picture frame, so they can be displayed in the device’s image editor.

This repo contains:

- `apps/web`: Next.js app that reads `data/artworks.json` and shows downloaded artworks
- `packages/scraper`: Node.js CLI to download public-domain artworks from multiple sources, resize them, and store metadata as JSON

## Web app

```bash
cd apps/web
yarn dev
```

Then open http://localhost:3000

The web app also exposes a read-only JSON API for the paperlesspaper app:

```txt
GET /api/artworks?q=cat&source=svgrepo&limit=40
GET /api/artworks/svgrepo%3A526478
```

It also redirects local image paths to `ART_ASSET_BASE_URL`, so image URLs keep
working through the app domain without bundling the image files into the Docker
image:

```txt
GET /images/svgrepo/528659/original.svg
```

Query parameters:

- `q`: searches title, artist, author, collection, license, source, source id, and tags
- `source`: `met`, `artic`, `wikimedia`, or `svgrepo`
- `publicDomain`: `true` or `false`
- `license`, `tag`, `collection`: simple text filters
- `limit`: defaults to `40`, max `200`
- `offset`: pagination offset

Runtime environment:

- `ART_CATALOG_URL`: optional remote `artworks.json` URL, e.g. an S3/CloudFront URL
- `ART_ASSET_BASE_URL`: optional public asset base URL, e.g. `https://cdn.paperlesspaper.de`
- `ART_ALLOWED_ORIGINS`: comma-separated CORS origins, defaults to `*`
- `ART_API_KEY`: optional API key. If set, clients must pass `Authorization: Bearer <key>` or `X-API-Key: <key>`
- `ART_CATALOG_CACHE_TTL_MS`: catalog cache TTL, defaults to `300000`

## Scraper CLI

```bash
cd packages/scraper
yarn install
yarn build
```

Run a download (writes into `apps/web/public/images` + `apps/web/data/artworks.json`):

```bash
cd packages/scraper
node dist/index.js met --query "landscape" --limit 10
node dist/index.js artic --query "portrait" --limit 10
node dist/index.js wikimedia --query "paintings" --limit 10
node dist/index.js svgrepo --query "cat" --limit 10
node dist/index.js svgrepo --collection-url "https://www.svgrepo.com/collection/bakery-education-line-icons/" --limit 25


node dist/index.js svgrepo --all-collections --collections-start 0 --per-collection-limit 100000 --api-prefer --cdp-url http://127.0.0.1:9222
```

Sources:

- The Metropolitan Museum of Art Collection API: https://metmuseum.github.io/
- Art Institute of Chicago API: https://api.artic.edu/docs/
- Wikimedia Commons API: https://www.mediawiki.org/wiki/API:Main_page
- SVG Repo: https://www.svgrepo.com/

Options:

- `--widths 512,1024` (default)
- `--web-root /absolute/path/to/apps/web` (only needed if autodetection fails)

For `svgrepo`, you can optionally connect to an already-running Chrome session (to reuse a manually verified session):

- `--cdp-url http://127.0.0.1:9222`

The `svgrepo` scraper prefers Google Chrome Canary via Playwright when available (falls back to stable Chrome, then bundled Chromium).

## Data layout

- Images: `apps/web/public/images/<source>/<sourceId>/...`
- Metadata: `apps/web/data/artworks.json`

## Hosting with Dokploy + S3

The scraper is an offline content pipeline. Do not run it inside request-time API
handlers.

1. Generate or update the catalog locally or in CI:

```bash
cd packages/scraper
yarn install
yarn build
node dist/index.js wikimedia --query "landscape" --limit 100
node dist/index.js svgrepo --query "cat" --limit 100
```

2. Publish generated assets to S3:

```bash
aws s3 sync apps/web/public/images s3://paperlesspaper-art/images --delete
aws s3 cp apps/web/data/artworks.json s3://paperlesspaper-art/artworks.json
```

3. Serve the S3 bucket through CloudFront or another CDN.

4. Deploy this repo in Dokploy with the included `Dockerfile` or
   `docker-compose.yml`.

Example Dokploy environment:

```env
ART_CATALOG_URL=https://cdn.paperlesspaper.de/artworks.json
ART_ASSET_BASE_URL=https://cdn.paperlesspaper.de
ART_ALLOWED_ORIGINS=https://paperlesspaper.de,https://app.paperlesspaper.de
ART_API_KEY=
ART_CATALOG_CACHE_TTL_MS=300000
```

The API service reads the catalog from S3/CDN, caches it in memory, and returns
S3/CDN-backed image URLs. Regeneration only happens when you run the scraper and
publish a new `artworks.json`.
