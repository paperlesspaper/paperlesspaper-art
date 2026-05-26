import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import type { Artwork } from "../artwork.js";
import { ensureDir } from "../fsutil.js";
import { getImageDimensions } from "../image-metadata.js";
import { downloadToFile, HttpError } from "../net.js";

type SvgrepoSession = {
  page: import("playwright").Page;
  requestContext: import("playwright").APIRequestContext;
  close: () => Promise<void>;
};

export class SvgrepoDownloadBlockedError extends Error {
  readonly status: number;
  readonly url: string;

  constructor(params: { status: number; url: string }) {
    super(`svgrepo: download blocked (HTTP ${params.status}) for ${params.url}`);
    this.name = "SvgrepoDownloadBlockedError";
    this.status = params.status;
    this.url = params.url;
  }
}

export async function fetchSvgrepoCollectionsPage(params: {
  requestContext: import("playwright").APIRequestContext;
  start: number;
}) {
  // Per user requirement: API paging uses a fixed limit=12.
  const fixedLimit = 12;

  const url = new URL("https://api.svgrepo.com/collections/");
  url.searchParams.set("limit", String(fixedLimit));
  url.searchParams.set("start", String(params.start));

  const res = await params.requestContext.get(url.toString(), {
    headers: {
      Referer: "https://www.svgrepo.com/",
      Accept: "application/json",
    },
  });

  if (!res.ok()) {
    throw new Error(
      `svgrepo: collections API failed (${res.status()} ${res.statusText()})`
    );
  }

  const json = (await res.json()) as any;
  const totalCount =
    typeof json?.count === "number" && Number.isFinite(json.count)
      ? (json.count as number)
      : null;
  const collections = Array.isArray(json?.collections) ? json.collections : [];

  const slugs = collections
    .map((c: any) => (typeof c?.slug === "string" ? c.slug.trim() : ""))
    .filter((s: string) => s.length > 0);

  return {
    slugs,
    totalCount,
    fixedLimit,
  };
}

export async function fetchSvgrepoCollectionsPageApiOnly(params: {
  start: number;
}) {
  // Per user requirement: API paging uses a fixed limit=12.
  const fixedLimit = 12;

  const url = new URL("https://api.svgrepo.com/collections/");
  url.searchParams.set("limit", String(fixedLimit));
  url.searchParams.set("start", String(params.start));

  const res = await fetch(url.toString(), {
    headers: {
      Referer: "https://www.svgrepo.com/",
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    throw new Error(
      `svgrepo: collections API failed (${res.status} ${res.statusText})`
    );
  }

  const json = (await res.json()) as any;
  const totalCount =
    typeof json?.count === "number" && Number.isFinite(json.count)
      ? (json.count as number)
      : null;
  const collections = Array.isArray(json?.collections) ? json.collections : [];

  const slugs = collections
    .map((c: any) => (typeof c?.slug === "string" ? c.slug.trim() : ""))
    .filter((s: string) => s.length > 0);

  return {
    slugs,
    totalCount,
    fixedLimit,
  };
}

export async function scrapeSvgrepoCollectionTerm(params: {
  term: string;
  limit: number;
  imagesRoot: string;
  downloadedAt: string;
  session: SvgrepoSession;
}) {
  const hrefs = await collectSvgHrefsFromCollectionApi({
    requestContext: params.session.requestContext,
    term: params.term,
  });

  return await scrapeFromHrefCandidates({
    hrefs,
    imagesRoot: params.imagesRoot,
    limit: params.limit,
    query: `collection:${params.term}`,
    downloadedAt: params.downloadedAt,
    page: params.session.page,
    requestContext: params.session.requestContext,
  });
}

export async function scrapeSvgrepoCollectionTermApiOnly(params: {
  term: string;
  limit: number;
  imagesRoot: string;
  downloadedAt: string;
}) {
  const hrefs = await collectSvgHrefsFromCollectionApiApiOnly({
    term: params.term,
  });

  return await scrapeFromHrefCandidatesApiOnly({
    hrefs,
    imagesRoot: params.imagesRoot,
    limit: params.limit,
    query: `collection:${params.term}`,
    downloadedAt: params.downloadedAt,
  });
}

export async function scrapeSvgrepo(params: {
  query: string;
  limit: number;
  imagesRoot: string;
  cdpUrl?: string;
  collectionUrl?: string;
}) {
  const downloadedAt = new Date().toISOString();

  const listingUrl = params.collectionUrl
    ? new URL(params.collectionUrl)
    : (() => {
        const u = new URL("https://www.svgrepo.com/search/");
        u.searchParams.set("q", params.query);
        return u;
      })();

  const collectionTerm = params.collectionUrl
    ? collectionTermFromUrl(params.collectionUrl)
    : null;

  const session = await openSvgrepoSession({
    cdpUrl: params.cdpUrl,
    urlToVisit: listingUrl.toString(),
  });

  try {
    const hrefs = collectionTerm
      ? await collectSvgHrefsFromCollectionApi({
          requestContext: session.requestContext,
          term: collectionTerm,
        })
      : await collectSvgHrefsFromListingPage(session.page, params.limit);

    return await scrapeFromHrefCandidates({
      hrefs,
      imagesRoot: params.imagesRoot,
      limit: params.limit,
      query: params.collectionUrl ?? params.query,
      downloadedAt,
      page: session.page,
      requestContext: session.requestContext,
    });
  } finally {
    await session.close();
  }
}

export async function openSvgrepoSession(params: {
  cdpUrl?: string;
  urlToVisit: string;
}): Promise<SvgrepoSession> {
  const storageStatePath = defaultSvgrepoStorageStatePath();
  await ensureDir(path.dirname(storageStatePath));

  const userAgent =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

  const headlessLaunchCandidates: Array<Parameters<typeof chromium.launch>[0]> =
    [
      // Prefer real installed Google Chrome Canary if available.
      { headless: true, channel: "chrome-canary" as const },
      // Then regular stable Chrome.
      { headless: true, channel: "chrome" as const },
      // Finally Playwright-bundled Chromium.
      { headless: true },
    ];

  const headedLaunchCandidates: Array<Parameters<typeof chromium.launch>[0]> = [
    { headless: false, channel: "chrome-canary" as const },
    { headless: false, channel: "chrome" as const },
    { headless: false },
  ];

  if (params.cdpUrl) {
    const browser = await chromium.connectOverCDP(params.cdpUrl);
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const page = await context.newPage();

    await page.goto(params.urlToVisit, { waitUntil: "domcontentloaded" });
    if (await isVercelCheckpoint(page)) {
      await browser.close().catch(() => undefined);
      throw new Error(
        [
          "Svgrepo shows a security checkpoint in the connected browser.",
          "Complete it manually in that Chrome window/tab, then re-run.",
        ].join("\n")
      );
    }

    return {
      page,
      requestContext: context.request,
      close: async () => {
        await browser.close().catch(() => undefined);
      },
    };
  }

  // Headless first; fall back to a one-time headed verification.
  const headlessBrowser = await launchFirstAvailable(headlessLaunchCandidates);

  const context = await headlessBrowser.newContext({
    userAgent,
    locale: "en-US",
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 2,
    timezoneId: "America/New_York",
    colorScheme: "light",
    storageState: (await fileExists(storageStatePath))
      ? storageStatePath
      : undefined,
  });
  const page = await context.newPage();
  await page.goto(params.urlToVisit, { waitUntil: "domcontentloaded" });

  if (!(await isVercelCheckpoint(page))) {
    return {
      page,
      requestContext: context.request,
      close: async () => {
        await headlessBrowser.close().catch(() => undefined);
      },
    };
  }

  // Need manual checkpoint.
  await context.close().catch(() => undefined);
  await headlessBrowser.close().catch(() => undefined);

  const headedBrowser = await launchFirstAvailable(headedLaunchCandidates);
  try {
    const headedContext = await headedBrowser.newContext({
      userAgent,
      locale: "en-US",
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: 2,
      timezoneId: "America/New_York",
      colorScheme: "light",
    });

    const headedPage = await headedContext.newPage();
    await headedPage.goto(params.urlToVisit, { waitUntil: "domcontentloaded" });

    console.log(
      "svgrepo: blocked by a security checkpoint. A browser window was opened; complete the check..."
    );

    try {
      await headedPage.waitForSelector('a[href^="/svg/"]', {
        timeout: 180_000,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        [
          "Svgrepo blocked this request behind a security checkpoint.",
          "",
          "To proceed, run this in a local interactive terminal session (GUI available),",
          "complete the checkpoint in the opened browser window, then re-run.",
          "",
          `Original error: ${message}`,
        ].join("\n")
      );
    }

    await headedContext.storageState({ path: storageStatePath });
    await headedContext.close();
  } finally {
    await headedBrowser.close().catch(() => undefined);
  }

  // Re-open headless with stored session.
  const browser2 = await launchFirstAvailable(headlessLaunchCandidates);
  const context2 = await browser2.newContext({
    userAgent,
    locale: "en-US",
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 2,
    timezoneId: "America/New_York",
    colorScheme: "light",
    storageState: storageStatePath,
  });
  const page2 = await context2.newPage();
  await page2.goto(params.urlToVisit, { waitUntil: "domcontentloaded" });

  return {
    page: page2,
    requestContext: context2.request,
    close: async () => {
      await browser2.close().catch(() => undefined);
    },
  };
}

function toPublicPath(imagesRoot: string, filePath: string) {
  const rel = path.relative(imagesRoot, filePath).split(path.sep).join("/");
  return `/images/${rel}`;
}

function unique<T>(items: T[]) {
  return [...new Set(items)];
}

function normalizeSvgHref(href: string) {
  // Normalize things like /svg/123/name/ -> /svg/123/name
  const match = href.match(/\/svg\/(\d+)\/([^/?#]+)\/?$/);
  if (!match) return null;
  return `/svg/${match[1]}/${match[2]}`;
}

async function scrapeFromHrefCandidates(params: {
  hrefs: string[];
  limit: number;
  query: string;
  downloadedAt: string;
  imagesRoot: string;
  page: import("playwright").Page;
  requestContext: import("playwright").APIRequestContext;
}) {
  const candidates = unique(
    params.hrefs
      .map((h) => normalizeSvgHref(h))
      .filter((h): h is string => typeof h === "string")
  );

  const artworks: Artwork[] = [];
  let satisfied = 0;

  for (const href of candidates) {
    const match = href.match(/^\/svg\/(\d+)\/([^/?#]+)$/);
    if (!match) continue;

    const sourceId = match[1];
    const slug = match[2];
    const sourceUrl = `https://www.svgrepo.com${href}`;

    const outDir = path.join(params.imagesRoot, "svgrepo", sourceId);
    const originalPath = path.join(outDir, "original.svg");
    if (await fileExists(originalPath)) {
      satisfied++;
      if (Number.isFinite(params.limit) && satisfied >= params.limit) break;
      continue;
    }

    await params.page.goto(sourceUrl, { waitUntil: "domcontentloaded" });

    const apiDetail = await fetchSvgrepoApiDetail({
      requestContext: params.requestContext,
      id: sourceId,
      slug,
    });

    const detail =
      apiDetail ??
      (await params.page
        .evaluate(() => {
          const abs = (href: string | null | undefined) => {
            if (!href) return undefined;
            try {
              return new URL(href, window.location.href).toString();
            } catch {
              return undefined;
            }
          };

          const text = (el: Element | null) =>
            (el?.textContent ?? "").replace(/\s+/g, " ").trim();

          const titleEl = (document.querySelector('h1[itemprop="name"]') ??
            document.querySelector("h1")) as Element | null;
          const descEl = document.querySelector(
            '[itemprop="description"]'
          ) as Element | null;

          const licenseA = document.querySelector(
            'a[rel="license"]'
          ) as HTMLAnchorElement | null;
          const authorA = document.querySelector(
            'a[rel="author"]'
          ) as HTMLAnchorElement | null;

          const tags = Array.from(document.querySelectorAll('a[rel="tag"]'))
            .map((a) => text(a))
            .filter(Boolean);

          const collectionLi = Array.from(document.querySelectorAll("li")).find(
            (li) =>
              text(li.querySelector("b")).toUpperCase().includes("COLLECTION")
          );
          const collectionA =
            (collectionLi?.querySelector("a") as HTMLAnchorElement | null) ??
            null;

          return {
            title: text(titleEl),
            description: text(descEl) || undefined,
            licenseName: text(licenseA) || undefined,
            licenseUrl: abs(licenseA?.getAttribute("href") ?? undefined),
            authorName: text(authorA) || undefined,
            authorUrl: abs(authorA?.getAttribute("href") ?? undefined),
            collectionName: text(collectionA) || undefined,
            collectionUrl: abs(collectionA?.getAttribute("href") ?? undefined),
            tags,
          };
        })
        .catch(() => ({
          title: "",
          description: undefined as string | undefined,
          licenseName: undefined as string | undefined,
          licenseUrl: undefined as string | undefined,
          authorName: undefined as string | undefined,
          authorUrl: undefined as string | undefined,
          collectionName: undefined as string | undefined,
          collectionUrl: undefined as string | undefined,
          tags: [] as string[],
        })));

    const title = detail.title;

    const downloadHref = await params.page
      .$$eval("a", (links) => {
        for (const a of links) {
          const href = a.getAttribute("href") ?? "";
          if (
            href.includes("/download/") &&
            href.toLowerCase().includes(".svg")
          ) {
            return href;
          }
        }
        return null;
      })
      .catch(() => null as string | null);

    const downloadUrl = new URL(
      downloadHref ?? `/download/${sourceId}/${slug}.svg`,
      "https://www.svgrepo.com"
    ).toString();

    const res = await params.requestContext.get(downloadUrl);
    if (!res.ok()) continue;

    const body = await res.body();

    await ensureDir(outDir);
    await fs.writeFile(originalPath, body);

    const originalPublic = toPublicPath(params.imagesRoot, originalPath);
    const dimensions = await getImageDimensions(originalPath).catch(
      () => undefined
    );
    if (!dimensions) continue;

    const license = detail.licenseName ?? "See source";
    const isPublicDomain =
      /\bpd\b/i.test(license) ||
      (detail.licenseUrl ? /#pd\b/i.test(detail.licenseUrl) : false);

    artworks.push({
      id: `svgrepo:${sourceId}`,
      source: "svgrepo",
      sourceId,
      title: title || `Svgrepo ${sourceId}`,
      description: detail.description,
      artist: detail.authorName,
      isPublicDomain,
      license,
      licenseUrl: detail.licenseUrl,
      collection:
        detail.collectionName && detail.collectionUrl
          ? { name: detail.collectionName, url: detail.collectionUrl }
          : undefined,
      author:
        detail.authorName && detail.authorUrl
          ? { name: detail.authorName, url: detail.authorUrl }
          : undefined,
      tags: detail.tags.length > 0 ? detail.tags : undefined,
      sourceUrl,
      image: {
        originalUrl: downloadUrl,
        ...dimensions,
        localOriginalPath: originalPublic,
      },
      search: {
        query: params.query,
        downloadedAt: params.downloadedAt,
      },
    });

    satisfied++;

    if (Number.isFinite(params.limit) && satisfied >= params.limit) break;
  }

  return artworks;
}

async function fetchSvgrepoApiDetail(params: {
  requestContext: import("playwright").APIRequestContext;
  id: string;
  slug: string;
}) {
  const url = `https://api.svgrepo.com/svg/${encodeURIComponent(
    params.id
  )}/${encodeURIComponent(params.slug)}`;
  try {
    const res = await params.requestContext.get(url, {
      headers: {
        Referer: "https://www.svgrepo.com/",
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
        "sec-ch-ua":
          '"Google Chrome";v="143", "Chromium";v="143", "Not A(Brand";v="24"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"macOS"',
        DNT: "1",
        Accept: "application/json",
      },
    });
    if (!res.ok()) return null;

    const json = (await res.json()) as any;
    const icon = json?.icon;
    if (!icon || typeof icon !== "object") return null;

    const licenseCode =
      typeof icon.license === "string" ? icon.license.trim() : undefined;
    const licenseUrl = licenseCode
      ? `https://www.svgrepo.com/page/licensing/#${encodeURIComponent(
          licenseCode
        )}`
      : undefined;

    const tags =
      typeof icon.tags === "string"
        ? unique(
            icon.tags
              .split(",")
              .map((t: string) => t.trim())
              .filter(Boolean)
          )
        : [];

    const collectionSlug =
      typeof icon.data_pack === "string" ? icon.data_pack.trim() : undefined;

    return {
      title:
        typeof icon.title === "string" && icon.title.trim().length > 0
          ? `${icon.title.trim()} SVG Vector`
          : "",
      description: undefined as string | undefined,
      licenseName: licenseCode ? `${licenseCode} License` : undefined,
      licenseUrl,
      authorName:
        typeof icon.license_owner === "string"
          ? icon.license_owner.trim()
          : undefined,
      authorUrl:
        typeof icon.license_link === "string"
          ? icon.license_link.trim()
          : undefined,
      collectionName: collectionSlug
        ? titleFromSlug(collectionSlug)
        : undefined,
      collectionUrl: collectionSlug
        ? `https://www.svgrepo.com/collection/${encodeURIComponent(
            collectionSlug
          )}/`
        : undefined,
      tags,
    };
  } catch {
    return null;
  }
}

async function fetchSvgrepoApiDetailApiOnly(params: {
  id: string;
  slug: string;
}) {
  const url = `https://api.svgrepo.com/svg/${encodeURIComponent(
    params.id
  )}/${encodeURIComponent(params.slug)}`;
  try {
    const res = await fetch(url, {
      headers: {
        Referer: "https://www.svgrepo.com/",
        Accept: "application/json",
      },
    });
    if (!res.ok) return null;

    const json = (await res.json()) as any;
    const icon = json?.icon;
    if (!icon || typeof icon !== "object") return null;

    const licenseCode =
      typeof icon.license === "string" ? icon.license.trim() : undefined;
    const licenseUrl = licenseCode
      ? `https://www.svgrepo.com/page/licensing/#${encodeURIComponent(
          licenseCode
        )}`
      : undefined;

    const tags =
      typeof icon.tags === "string"
        ? unique(
            icon.tags
              .split(",")
              .map((t: string) => t.trim())
              .filter(Boolean)
          )
        : [];

    const collectionSlug =
      typeof icon.data_pack === "string" ? icon.data_pack.trim() : undefined;

    return {
      title:
        typeof icon.title === "string" && icon.title.trim().length > 0
          ? `${icon.title.trim()} SVG Vector`
          : "",
      description: undefined as string | undefined,
      licenseName: licenseCode ? `${licenseCode} License` : undefined,
      licenseUrl,
      authorName:
        typeof icon.license_owner === "string"
          ? icon.license_owner.trim()
          : undefined,
      authorUrl:
        typeof icon.license_link === "string"
          ? icon.license_link.trim()
          : undefined,
      collectionName: collectionSlug
        ? titleFromSlug(collectionSlug)
        : undefined,
      collectionUrl: collectionSlug
        ? `https://www.svgrepo.com/collection/${encodeURIComponent(
            collectionSlug
          )}/`
        : undefined,
      tags,
    };
  } catch {
    return null;
  }
}

function titleFromSlug(slug: string) {
  return slug
    .split(/[-_]+/g)
    .filter(Boolean)
    .map((w) => w.slice(0, 1).toUpperCase() + w.slice(1))
    .join(" ");
}

async function collectSvgHrefsFromListingPage(
  page: import("playwright").Page,
  limit: number
) {
  const collected = new Set<string>();

  // Give initial render a moment.
  await page
    .waitForSelector('a[href^="/svg/"]', { timeout: 20_000 })
    .catch(() => undefined);

  for (let i = 0; i < 25; i++) {
    const hrefs = await page
      .$$eval('a[href^="/svg/"]', (links) =>
        links
          .map((a) => a.getAttribute("href"))
          .filter((x): x is string => typeof x === "string" && x.length > 0)
      )
      .catch(() => [] as string[]);

    for (const h of hrefs) collected.add(h);
    if (collected.size >= limit) break;

    const before = collected.size;

    await page
      .evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight);
      })
      .catch(() => undefined);

    await page.waitForTimeout(900);

    if (collected.size === before) {
      // Nothing new after a scroll; try a little longer then give up.
      await page.waitForTimeout(900);
    }
  }

  return [...collected];
}

async function collectSvgHrefsFromCollectionApi(params: {
  requestContext: import("playwright").APIRequestContext;
  term: string;
}) {
  const pageSize = 50;
  const hrefs: string[] = [];

  let start = 0;
  let totalCount: number | null = null;

  while (true) {
    const batchLimit = pageSize;
    const url = new URL("https://api.svgrepo.com/collection/");
    url.searchParams.set("term", params.term);
    url.searchParams.set("limit", String(batchLimit));
    url.searchParams.set("start", String(start));

    const res = await params.requestContext.get(url.toString(), {
      headers: {
        Referer: "https://www.svgrepo.com/",
        Accept: "application/json",
      },
    });
    if (!res.ok()) break;

    const json = (await res.json()) as any;
    const icons = Array.isArray(json?.icons) ? json.icons : [];
    if (typeof json?.count === "number" && Number.isFinite(json.count)) {
      totalCount = json.count;
    }

    if (icons.length === 0) break;

    for (const icon of icons) {
      const id =
        typeof icon?.id === "string" ? icon.id : String(icon?.id ?? "");
      const slug = typeof icon?.slug === "string" ? icon.slug : "";
      if (!id || !slug) continue;
      hrefs.push(`/svg/${id}/${slug}`);
    }

    start += icons.length;
    if (totalCount !== null && start >= totalCount) break;
  }

  return hrefs;
}

async function collectSvgHrefsFromCollectionApiApiOnly(params: {
  term: string;
}) {
  const pageSize = 50;
  const hrefs: string[] = [];

  let start = 0;
  let totalCount: number | null = null;

  while (true) {
    const url = new URL("https://api.svgrepo.com/collection/");
    url.searchParams.set("term", params.term);
    url.searchParams.set("limit", String(pageSize));
    url.searchParams.set("start", String(start));

    const res = await fetch(url.toString(), {
      headers: {
        Referer: "https://www.svgrepo.com/",
        Accept: "application/json",
      },
    });
    if (!res.ok) break;

    const json = (await res.json()) as any;
    const icons = Array.isArray(json?.icons) ? json.icons : [];
    if (typeof json?.count === "number" && Number.isFinite(json.count)) {
      totalCount = json.count;
    }

    if (icons.length === 0) break;

    for (const icon of icons) {
      const id =
        typeof icon?.id === "string" ? icon.id : String(icon?.id ?? "");
      const slug = typeof icon?.slug === "string" ? icon.slug : "";
      if (!id || !slug) continue;
      hrefs.push(`/svg/${id}/${slug}`);
    }

    start += icons.length;
    if (totalCount !== null && start >= totalCount) break;
  }

  return hrefs;
}

async function scrapeFromHrefCandidatesApiOnly(params: {
  hrefs: string[];
  limit: number;
  query: string;
  downloadedAt: string;
  imagesRoot: string;
}) {
  const candidates = unique(
    params.hrefs
      .map((h) => normalizeSvgHref(h))
      .filter((h): h is string => typeof h === "string")
  );

  const artworks: Artwork[] = [];
  let satisfied = 0;

  for (const href of candidates) {
    const match = href.match(/^\/svg\/(\d+)\/([^/?#]+)$/);
    if (!match) continue;

    const sourceId = match[1];
    const slug = match[2];
    const sourceUrl = `https://www.svgrepo.com${href}`;

    const outDir = path.join(params.imagesRoot, "svgrepo", sourceId);
    const originalPath = path.join(outDir, "original.svg");
    if (await fileExists(originalPath)) {
      satisfied++;
      if (Number.isFinite(params.limit) && satisfied >= params.limit) break;
      continue;
    }

    const detail = await fetchSvgrepoApiDetailApiOnly({ id: sourceId, slug });
    if (!detail) continue;

    const title = detail.title;
    const downloadUrl = `https://www.svgrepo.com/download/${encodeURIComponent(
      sourceId
    )}/${encodeURIComponent(slug)}.svg`;

    await ensureDir(outDir);
    try {
      await downloadToFile(downloadUrl, originalPath, {
        Referer: "https://www.svgrepo.com/",
        Accept: "image/svg+xml,*/*",
      });
    } catch (err) {
      if (err instanceof HttpError && (err.status === 429 || err.status === 403)) {
        throw new SvgrepoDownloadBlockedError({ status: err.status, url: err.url });
      }
      continue;
    }

    const originalPublic = toPublicPath(params.imagesRoot, originalPath);
    const dimensions = await getImageDimensions(originalPath).catch(
      () => undefined
    );
    if (!dimensions) continue;

    const license = detail.licenseName ?? "See source";
    const isPublicDomain =
      /\bpd\b/i.test(license) ||
      (detail.licenseUrl ? /#pd\b/i.test(detail.licenseUrl) : false);

    artworks.push({
      id: `svgrepo:${sourceId}`,
      source: "svgrepo",
      sourceId,
      title: title || `Svgrepo ${sourceId}`,
      description: detail.description,
      artist: detail.authorName,
      isPublicDomain,
      license,
      licenseUrl: detail.licenseUrl,
      collection:
        detail.collectionName && detail.collectionUrl
          ? { name: detail.collectionName, url: detail.collectionUrl }
          : undefined,
      author:
        detail.authorName && detail.authorUrl
          ? { name: detail.authorName, url: detail.authorUrl }
          : undefined,
      tags: detail.tags.length > 0 ? detail.tags : undefined,
      sourceUrl,
      image: {
        originalUrl: downloadUrl,
        ...dimensions,
        localOriginalPath: originalPublic,
      },
      search: {
        query: params.query,
        downloadedAt: params.downloadedAt,
      },
    });

    satisfied++;

    if (Number.isFinite(params.limit) && satisfied >= params.limit) break;
  }

  return artworks;
}

function collectionTermFromUrl(url: string) {
  try {
    const u = new URL(url);
    const match = u.pathname.match(/\/collection\/([^/]+)\/?/);
    return match ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}

async function isVercelCheckpoint(page: import("playwright").Page) {
  try {
    const title = await page.title();
    if (title.toLowerCase().includes("security checkpoint")) return true;
  } catch {
    // ignore
  }

  const bodyText = await page
    .locator("body")
    .innerText({ timeout: 2_000 })
    .catch(() => "");
  return bodyText.toLowerCase().includes("security checkpoint");
}

function defaultSvgrepoStorageStatePath() {
  return path.join(
    os.homedir(),
    ".cache",
    "paperlesspaper-art",
    "svgrepo.storage-state.json"
  );
}

async function fileExists(p: string) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function launchFirstAvailable(
  candidates: Array<Parameters<typeof chromium.launch>[0]>
) {
  let lastErr: unknown = null;
  for (const opts of candidates) {
    try {
      return await chromium.launch(opts);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error(`Failed to launch browser: ${String(lastErr)}`);
}
