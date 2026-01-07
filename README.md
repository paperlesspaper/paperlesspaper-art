# paperlesspaper Art

This repo contains:

- `apps/web`: Next.js app that reads `data/artworks.json` and shows downloaded artworks
- `packages/scraper`: Node.js CLI to download public-domain artworks from multiple sources, resize them, and store metadata as JSON

## Web app

```bash
cd apps/web
npm run dev
```

Then open http://localhost:3000

## Scraper CLI

```bash
cd packages/scraper
npm install
npm run build
```

Run a download (writes into `apps/web/public/images` + `apps/web/data/artworks.json`):

```bash
cd packages/scraper
node dist/index.js met --query "landscape" --limit 10
node dist/index.js artic --query "portrait" --limit 10
node dist/index.js svgrepo --query "cat" --limit 10
node dist/index.js svgrepo --collection-url "https://www.svgrepo.com/collection/bakery-education-line-icons/" --limit 25
```

Options:

- `--widths 512,1024` (default)
- `--web-root /absolute/path/to/apps/web` (only needed if autodetection fails)

For `svgrepo`, you can optionally connect to an already-running Chrome session (to reuse a manually verified session):

- `--cdp-url http://127.0.0.1:9222`

The `svgrepo` scraper prefers Google Chrome Canary via Playwright when available (falls back to stable Chrome, then bundled Chromium).

## Data layout

- Images: `apps/web/public/images/<source>/<sourceId>/...`
- Metadata: `apps/web/data/artworks.json`
