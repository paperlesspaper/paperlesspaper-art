import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  ensureArtworkDatabase,
  getArtworkPool,
} from "@/lib/artwork-database";
import type {
  CoveredKeyword,
  KeywordCoverage,
  KeywordSuggestion,
  ScraperLogLine,
  ScraperPendingPreview,
  ScraperPreviewDecision,
  ScraperPreviewDecisionSummary,
  ScraperProgress,
  ScraperProgressStats,
  ScraperRunConfig,
  ScraperRunPhase,
  ScraperStatusResponse,
} from "@/lib/scraper-types";

type ManagedScraperRun = {
  phase: ScraperRunPhase;
  command?: "build" | "scrape";
  child?: ChildProcess;
  pid?: number;
  startedAt: string;
  finishedAt?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  error?: string;
  stopRequested: boolean;
  config: ScraperRunConfig;
  scraperRoot: string;
  webRoot: string;
  reviewDir?: string;
  logs: ScraperLogLine[];
  progress?: ScraperProgress;
  previewDecisionSubmitted?: {
    id: string;
    decision: ScraperPreviewDecision;
  };
};

type ScraperPaths = {
  repoRoot: string;
  scraperRoot: string;
  webRoot: string;
};

type KeywordRow = {
  keyword: string | null;
  downloadedCount: string;
  firstDownloadedAt: string | null;
  lastDownloadedAt: string | null;
};

type PreviewDecisionCountRow = {
  decision: ScraperPreviewDecision;
  decisionCount: string;
  downloadedCount: string;
  lastDecidedAt: string | null;
};

type PreviewDecisionRecentRow = {
  id: string;
  sourceId?: string;
  title: string;
  decision: ScraperPreviewDecision;
  query: string | null;
  decidedAt: string | null;
  downloaded: boolean;
  previewUrl?: string | null;
  previewLocalPath?: string | null;
  sourceUrl?: string | null;
  metadata?: Record<string, unknown> | null;
  rating?: number | null;
};

declare global {
  var wikimediaScraperRun: ManagedScraperRun | undefined;
}

const MAX_LOG_LINES = 240;
const MAX_KEYWORDS = 30;
const DEFAULT_WIDTHS = "512,1024";
const DEFAULT_LIMIT = 100;
const DEFAULT_THUMB_WIDTH = 2048;
const DEFAULT_PREVIEW_WIDTH = 160;
const DEFAULT_FULL_DOWNLOAD_CONCURRENCY = 3;
const DEFAULT_DOWNLOAD_DELAY_MS = 5000;
const DEFAULT_SUCCESS_DELAY = 30;
const DEFAULT_RESTART_DELAY = 10;

const EMPTY_PROGRESS_STATS: ScraperProgressStats = {
  pages: 0,
  accepted: 0,
  previewed: 0,
  previewPending: 0,
  previewApproved: 0,
  previewRejected: 0,
  inserted: 0,
  updated: 0,
  upserted: 0,
  skippedExisting: 0,
  skippedPreviewDownload: 0,
  skippedPreviewPending: 0,
  skippedPreviewRejected: 0,
  skippedPreviewApproved: 0,
  skippedDownload: 0,
  skippedLicense: 0,
  skippedNonArt: 0,
  skippedUsage: 0,
  skippedType: 0,
  skippedResize: 0,
  skippedMetadata: 0,
  skippedNoImageInfo: 0,
  skippedNoImageUrl: 0,
  skippedDuplicateTitle: 0,
};

const SUGGESTION_SEEDS: Array<{
  keyword: string;
  reason: string;
  source: KeywordSuggestion["source"];
}> = [
  {
    keyword: "landscape paintings",
    reason: "Broad art query with many public-domain candidates",
    source: "starter",
  },
  {
    keyword: "portrait paintings",
    reason: "Good coverage for people, faces, and frame-friendly compositions",
    source: "starter",
  },
  {
    keyword: "still life paintings",
    reason: "Usually clean, display-friendly subject matter",
    source: "starter",
  },
  {
    keyword: "botanical illustration",
    reason: "Public-domain plates tend to resize well",
    source: "starter",
  },
  {
    keyword: "watercolor landscape",
    reason: "Adds softer color and paper texture variation",
    source: "gap",
  },
  {
    keyword: "Japanese woodblock print",
    reason: "Strong graphic compositions and public-domain scans",
    source: "gap",
  },
  {
    keyword: "Dutch Golden Age painting",
    reason: "Reliable museum-quality historical material",
    source: "gap",
  },
  {
    keyword: "Impressionist painting",
    reason: "Useful color and brushwork range",
    source: "gap",
  },
  {
    keyword: "Expressionist painting",
    reason: "Adds bolder shapes and color contrast",
    source: "gap",
  },
  {
    keyword: "marine painting",
    reason: "Water, ships, and skies broaden landscape coverage",
    source: "gap",
  },
  {
    keyword: "cityscape painting",
    reason: "Architecture-heavy scenes complement nature landscapes",
    source: "gap",
  },
  {
    keyword: "flower paintings",
    reason: "Pairs well with still-life and botanical material",
    source: "related",
  },
  {
    keyword: "animal paintings",
    reason: "Adds subjects that are easy to browse visually",
    source: "related",
  },
  {
    keyword: "mythological paintings",
    reason: "Finds narrative works across European collections",
    source: "related",
  },
  {
    keyword: "religious paintings",
    reason: "Large historical corpus with well-documented sources",
    source: "related",
  },
  {
    keyword: "female artists paintings",
    reason: "Helps diversify artist coverage",
    source: "gap",
  },
  {
    keyword: "abstract painting",
    reason: "Adds modern composition variety where licensing allows",
    source: "gap",
  },
  {
    keyword: "public domain art museum",
    reason: "General fallback for museum-sourced Commons files",
    source: "starter",
  },
];

export async function getScraperStatus(params: {
  keywords?: string;
} = {}): Promise<ScraperStatusResponse> {
  const run = globalThis.wikimediaScraperRun;
  const requestedKeywords = parseKeywordInput(params.keywords);
  const statusBase = buildRunStatus(run);

  try {
    const paths = resolveScraperPaths();
    const coveredKeywords = await loadCoveredKeywords(paths);
    const previewDecisions = await loadPreviewDecisionSummary();

    return {
      ...statusBase,
      scraperRoot: paths.scraperRoot,
      pendingPreview: previewDecisions.pending[0],
      pendingPreviews: previewDecisions.pending,
      previewDecisions,
      coveredKeywords,
      keywordCoverage: buildKeywordCoverage(requestedKeywords, coveredKeywords),
      suggestions: buildKeywordSuggestions(coveredKeywords, requestedKeywords),
    };
  } catch (error) {
    return {
      ...statusBase,
      pendingPreviews: [],
      previewDecisions: emptyPreviewDecisionSummary(),
      coveredKeywords: [],
      keywordCoverage: requestedKeywords.map((keyword) => ({
        keyword,
        requestedKeyword: keyword,
        normalizedKeyword: normalizeKeyword(keyword),
        downloadedCount: 0,
        status: "new" as const,
      })),
      suggestions: SUGGESTION_SEEDS.map((seed) => ({ ...seed })).slice(0, 12),
      databaseError:
        error instanceof Error ? error.message : "Failed to load scraper data",
    };
  }
}

export async function startScraper(body: unknown) {
  const currentRun = globalThis.wikimediaScraperRun;
  if (currentRun && isActiveRun(currentRun)) {
    throw new Error("The Wikimedia scraper is already running");
  }

  const paths = resolveScraperPaths();
  const parsedConfig = parseStartConfig(body);
  const reviewDir = path.join(paths.scraperRoot, ".wikimedia-preview-review");
  const coveredKeywords = await loadCoveredKeywords(paths);
  const coveredByNormalized = new Map(
    coveredKeywords.map((keyword) => [keyword.normalizedKeyword, keyword])
  );
  const skippedCoveredKeywords = parsedConfig.skipCovered
    ? parsedConfig.requestedKeywords.filter((keyword) =>
        isKeywordSkippable(coveredByNormalized.get(normalizeKeyword(keyword)))
      )
    : [];
  const keywords = parsedConfig.requestedKeywords.filter(
    (keyword) =>
      !parsedConfig.skipCovered ||
      !isKeywordSkippable(coveredByNormalized.get(normalizeKeyword(keyword)))
  );

  if (keywords.length === 0) {
    throw new Error("All selected keywords are already completed");
  }

  const config: ScraperRunConfig = {
    ...parsedConfig,
    keywords,
    skippedCoveredKeywords,
  };
  const run: ManagedScraperRun = {
    phase: "building",
    command: "build",
    stopRequested: false,
    startedAt: new Date().toISOString(),
    config,
    scraperRoot: paths.scraperRoot,
    webRoot: paths.webRoot,
    reviewDir,
    logs: [],
    progress: createInitialProgress("building"),
  };

  globalThis.wikimediaScraperRun = run;
  appendLog(
    run,
    "system",
    `Building scraper before starting ${keywords.length} keyword${
      keywords.length === 1 ? "" : "s"
    }`
  );
  spawnBuild(run);

  return getScraperStatus({ keywords: config.requestedKeywords.join("\n") });
}

export async function stopScraper() {
  const run = globalThis.wikimediaScraperRun;

  if (!run || !isActiveRun(run)) {
    return getScraperStatus();
  }

  run.stopRequested = true;
  run.phase = "stopping";
  const progress = ensureRunProgress(run);
  progress.stage = "stopping";
  progress.message = "Stopping scraper process";
  progress.updatedAt = new Date().toISOString();
  appendLog(run, "system", "Stopping scraper process");
  if (!terminateChild(run, "SIGTERM")) {
    finishRun(run, null, null);
  }

  return getScraperStatus({
    keywords: run.config.requestedKeywords.join("\n"),
  });
}

export async function submitPreviewDecision(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Invalid preview decision request body");
  }

  const record = body as Record<string, unknown>;
  const previewId = typeof record.previewId === "string" ? record.previewId : "";
  if (!previewId) {
    throw new Error("Preview decision is missing a preview id");
  }

  const rating = parsePreviewRating(record.rating);
  const decision = rating === 1 ? "rejected" : "approved";
  const decidedAt = new Date().toISOString();
  const updatedTitle = await updatePreviewDecision(
    previewId,
    decision,
    decidedAt,
    rating
  );
  const run = globalThis.wikimediaScraperRun;

  if (run && isActiveRun(run)) {
    const progress = ensureRunProgress(run);
    progress.stage = "reviewing";
    progress.currentTitle = updatedTitle;
    progress.message =
      decision === "approved"
        ? "Preview approved; waiting for scraper pass"
        : "Preview rejected; waiting for scraper pass";
    progress.updatedAt = decidedAt;
    appendLog(
      run,
      "system",
      `Preview rated ${rating} (${decision === "approved" ? "approved" : "rejected"}): ${
        updatedTitle
      }`
    );
  }

  return getScraperStatus({
    keywords: run?.config.requestedKeywords.join("\n"),
  });
}

export async function getScraperPreviewImage(previewId: string | null) {
  if (!previewId) {
    return new Response("Preview not found", { status: 404 });
  }

  const paths = resolveScraperPaths();
  const previewLocalPath = await loadPreviewImagePath(previewId).catch(
    () => undefined
  );
  if (!previewLocalPath) {
    return new Response("Preview not found", { status: 404 });
  }

  const allowedRoot = path.resolve(
    paths.webRoot,
    "public",
    "images",
    "wikimedia-previews"
  );
  const previewPath = path.resolve(previewLocalPath);

  if (
    previewPath !== allowedRoot &&
    !previewPath.startsWith(`${allowedRoot}${path.sep}`)
  ) {
    return new Response("Preview path is outside the preview directory", {
      status: 400,
    });
  }

  if (!fs.existsSync(previewPath)) {
    return new Response("Preview image not found", { status: 404 });
  }

  const image = fs.readFileSync(previewPath);
  return new Response(new Uint8Array(image), {
    headers: {
      "Cache-Control": "no-store, max-age=0",
      "Content-Type": contentTypeForImagePath(previewPath),
    },
  });
}

function spawnBuild(run: ManagedScraperRun) {
  const child = spawn("npm", ["run", "build"], {
    cwd: run.scraperRoot,
    detached: true,
    env: {
      ...process.env,
      CI: process.env.CI ?? "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  run.child = child;
  run.pid = child.pid;
  wireChildLogs(run, child);

  child.on("error", (error) => finishRunWithError(run, error.message));
  child.on("exit", (code, signal) => {
    if (run.child !== child) return;

    if (run.stopRequested) {
      finishRun(run, code, signal);
      return;
    }

    if (code === 0) {
      appendLog(run, "system", "Scraper build finished");
      spawnScraperLoop(run);
      return;
    }

    finishRunWithError(run, `Scraper build exited with code ${code ?? "null"}`);
  });
}

function spawnScraperLoop(run: ManagedScraperRun) {
  run.phase = "running";
  run.command = "scrape";
  run.child = undefined;
  run.pid = undefined;
  const progress = ensureRunProgress(run);
  progress.stage = "starting";
  progress.message = "Starting Wikimedia scraper loop";
  progress.updatedAt = new Date().toISOString();

  const env = buildScraperEnv(run);
  const child = spawn("bash", ["scripts/scrape-wikimedia-loop.sh"], {
    cwd: run.scraperRoot,
    detached: true,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  run.child = child;
  run.pid = child.pid;
  appendLog(run, "system", "Wikimedia scraper loop started");
  wireChildLogs(run, child);

  child.on("error", (error) => finishRunWithError(run, error.message));
  child.on("exit", (code, signal) => {
    if (run.child !== child) return;

    if (run.stopRequested) {
      finishRun(run, code, signal);
      return;
    }

    if (code === 0) {
      finishRun(run, code, signal);
      return;
    }

    finishRunWithError(
      run,
      `Scraper loop exited with code ${code ?? "null"}`
    );
  });
}

function buildScraperEnv(run: ManagedScraperRun) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    KEYWORDS: run.config.keywords.join("\n"),
    LIMIT: String(run.config.limit),
    WIDTHS: run.config.widths,
    MIN_GLOBAL_USAGE: String(run.config.minGlobalUsage),
    MIN_LOCAL_USAGE: String(run.config.minLocalUsage),
    THUMB_WIDTH: String(run.config.thumbWidth),
    ALLOW_DUPLICATE_TITLES: run.config.allowDuplicateTitles ? "1" : "0",
    REVISIT_REJECTED_PREVIEWS: run.config.revisitRejectedPreviews ? "1" : "0",
    DISABLE_CANDIDATE_FILTERS: run.config.disableCandidateFilters ? "1" : "0",
    IGNORE_USAGE_FILTER: run.config.ignoreUsageFilter ? "1" : "0",
    ART_FILTER_MODE: run.config.artFilterMode,
    REVIEW_MODE: run.config.reviewMode,
    FULL_DOWNLOAD_CONCURRENCY: String(run.config.fullDownloadConcurrency),
    PREVIEW_REVIEW: run.config.previewReview ? "1" : "0",
    PREVIEW_WIDTH: String(run.config.previewWidth),
    DOWNLOAD_DELAY_MS: String(run.config.downloadDelayMs),
    SUCCESS_DELAY: String(run.config.successDelay),
    RESTART_DELAY: String(run.config.restartDelay),
    MAX_FAILURES: String(run.config.maxFailures),
    REFRESH_EXISTING: run.config.refreshExisting ? "1" : "0",
    NODE_BIN: process.execPath,
    WEB_ROOT: run.webRoot,
  };

  if (run.config.previewReview && run.reviewDir) {
    env.PREVIEW_REVIEW_DIR = run.reviewDir;
  }

  const userAgent = run.config.userAgent?.trim();
  if (userAgent) env.WIKIMEDIA_USER_AGENT = userAgent;

  return env;
}

function wireChildLogs(run: ManagedScraperRun, child: ChildProcess) {
  child.stdout?.on("data", (chunk: Buffer) =>
    appendChunk(run, "stdout", chunk)
  );
  child.stderr?.on("data", (chunk: Buffer) =>
    appendChunk(run, "stderr", chunk)
  );
}

function appendChunk(
  run: ManagedScraperRun,
  stream: ScraperLogLine["stream"],
  chunk: Buffer
) {
  for (const line of chunk.toString("utf8").split(/\r?\n/)) {
    if (line.trim()) appendLog(run, stream, line);
  }
}

function appendLog(
  run: ManagedScraperRun,
  stream: ScraperLogLine["stream"],
  line: string
) {
  updateProgressFromLog(run, line);
  run.logs.push({
    stream,
    line,
    timestamp: new Date().toISOString(),
  });

  if (run.logs.length > MAX_LOG_LINES) {
    run.logs.splice(0, run.logs.length - MAX_LOG_LINES);
  }
}

function createInitialProgress(stage: ScraperProgress["stage"]): ScraperProgress {
  return {
    stage,
    message: stage === "building" ? "Building scraper" : undefined,
    runsStarted: 0,
    runsCompleted: 0,
    failures: 0,
    stats: { ...EMPTY_PROGRESS_STATS },
    fullDownloads: {
      total: 0,
      queued: 0,
      started: 0,
      downloaded: 0,
      accepted: 0,
      upserted: 0,
      failed: 0,
      concurrency: 1,
    },
    updatedAt: new Date().toISOString(),
  };
}

function ensureRunProgress(run: ManagedScraperRun) {
  if (!run.progress) {
    run.progress = createInitialProgress(
      run.phase === "building"
        ? "building"
        : run.phase === "running"
          ? "starting"
          : run.phase === "stopping"
            ? "stopping"
            : run.phase === "error"
              ? "error"
              : "idle"
    );
  }

  run.progress.fullDownloads ??= {
    total: 0,
    queued: 0,
    started: 0,
    downloaded: 0,
    accepted: 0,
    upserted: 0,
    failed: 0,
    concurrency: 1,
  };

  return run.progress;
}

function updateProgressFromLog(run: ManagedScraperRun, line: string) {
  const progress = ensureRunProgress(run);
  const now = new Date().toISOString();
  progress.updatedAt = now;

  if (line.startsWith("Building scraper")) {
    progress.stage = "building";
    progress.message = line;
    return;
  }

  if (line === "Scraper build finished") {
    progress.stage = "starting";
    progress.message = "Build finished; starting scraper loop";
    return;
  }

  if (line === "Wikimedia scraper loop started") {
    progress.stage = "starting";
    progress.message = "Scraper loop started";
    return;
  }

  const runStartMatch = line.match(
    /^scrape-wikimedia: run ([0-9]+) starting query '(.+)' at search offset ([0-9]+)$/
  );
  if (runStartMatch) {
    const runNumber = Number(runStartMatch[1]);
    progress.stage = "searching";
    progress.currentRun = runNumber;
    progress.currentKeyword = runStartMatch[2];
    progress.currentOffset = Number(runStartMatch[3]);
    progress.currentTitle = undefined;
    progress.currentUsage = undefined;
    progress.runsStarted = Math.max(progress.runsStarted, runNumber);
    progress.message = `Searching ${runStartMatch[2]}`;
    return;
  }

  const usageMatch = line.match(
    /^Wikimedia file (.+) has global usage ([0-9]+) and local usage ([0-9]+)$/
  );
  if (usageMatch) {
    progress.stage = "checking";
    progress.currentTitle = usageMatch[1];
    progress.currentUsage = {
      global: Number(usageMatch[2]),
      local: Number(usageMatch[3]),
    };
    progress.message = "Checking file usage and license";
    return;
  }

  const fullDownloadConcurrencyMatch = line.match(
    /^Wikimedia full downloads concurrency ([0-9]+)$/
  );
  if (fullDownloadConcurrencyMatch) {
    progress.fullDownloads.concurrency = Number(fullDownloadConcurrencyMatch[1]);
    progress.stage = "checking";
    progress.message = `Full image downloads will run x${fullDownloadConcurrencyMatch[1]}`;
    return;
  }

  const fullDownloadQueuedMatch = line.match(
    /^Wikimedia queued full download (.+)$/
  );
  if (fullDownloadQueuedMatch) {
    progress.fullDownloads.queued++;
    progress.stage = "checking";
    progress.currentTitle = fullDownloadQueuedMatch[1];
    progress.message = "Queued for parallel full download";
    return;
  }

  const fullDownloadBatchMatch = line.match(
    /^Wikimedia running ([0-9]+) full downloads with concurrency ([0-9]+)$/
  );
  if (fullDownloadBatchMatch) {
    progress.fullDownloads.total = Number(fullDownloadBatchMatch[1]);
    progress.fullDownloads.concurrency = Number(fullDownloadBatchMatch[2]);
    progress.stage = "downloading";
    progress.message = `Downloading ${fullDownloadBatchMatch[1]} full images, x${fullDownloadBatchMatch[2]} parallel`;
    return;
  }

  const downloadingMatch = line.match(/^Wikimedia downloading (.+)$/);
  if (downloadingMatch) {
    progress.fullDownloads.started++;
    progress.stage = "downloading";
    progress.currentTitle = downloadingMatch[1];
    progress.message = "Downloading original image";
    return;
  }

  const downloadedMatch = line.match(/^Wikimedia downloaded (.+)$/);
  if (downloadedMatch) {
    progress.fullDownloads.downloaded++;
    progress.stage = "resizing";
    progress.currentTitle = downloadedMatch[1];
    progress.lastDownloadedTitle = downloadedMatch[1];
    progress.message = "Downloaded original image";
    return;
  }

  const localMatch = line.match(/^Wikimedia file (.+) already exists locally$/);
  if (localMatch) {
    progress.fullDownloads.downloaded++;
    progress.stage = "resizing";
    progress.currentTitle = localMatch[1];
    progress.lastDownloadedTitle = localMatch[1];
    progress.message = "Using existing local original";
    return;
  }

  const resizingMatch = line.match(/^Wikimedia resizing (.+)$/);
  if (resizingMatch) {
    progress.stage = "resizing";
    progress.currentTitle = resizingMatch[1];
    progress.message = "Creating resized images";
    return;
  }

  const previewSkippedRejectedMatch = line.match(
    /^Wikimedia preview skipped rejected (.+)$/
  );
  if (previewSkippedRejectedMatch) {
    progress.stage = "checking";
    progress.currentTitle = previewSkippedRejectedMatch[1];
    progress.message = "Skipped rejected preview";
    return;
  }

  const previewSkippedPendingMatch = line.match(
    /^Wikimedia preview skipped pending (.+)$/
  );
  if (previewSkippedPendingMatch) {
    progress.stage = "reviewing";
    progress.currentTitle = previewSkippedPendingMatch[1];
    progress.lastPreviewTitle = previewSkippedPendingMatch[1];
    progress.message = "Preview is waiting for review";
    return;
  }

  const previewSkippedApprovedMatch = line.match(
    /^Wikimedia preview skipped approved (.+)$/
  );
  if (previewSkippedApprovedMatch) {
    progress.stage = "checking";
    progress.currentTitle = previewSkippedApprovedMatch[1];
    progress.message = "Preview already approved";
    return;
  }

  const previewSkippedUnreviewedMatch = line.match(
    /^Wikimedia preview skipped unreviewed (.+)$/
  );
  if (previewSkippedUnreviewedMatch) {
    progress.stage = "reviewing";
    progress.currentTitle = previewSkippedUnreviewedMatch[1];
    progress.message = "Waiting for a preview rating";
    return;
  }

  const previewDownloadingMatch = line.match(
    /^Wikimedia preview downloading (.+)$/
  );
  if (previewDownloadingMatch) {
    progress.stage = "downloading";
    progress.currentTitle = previewDownloadingMatch[1];
    progress.message = "Downloading review preview";
    return;
  }

  const previewLocalMatch = line.match(
    /^Wikimedia preview file (.+) already exists locally$/
  );
  if (previewLocalMatch) {
    progress.stage = "reviewing";
    progress.currentTitle = previewLocalMatch[1];
    progress.lastPreviewTitle = previewLocalMatch[1];
    progress.message = "Using existing review preview";
    return;
  }

  const previewReadyMatch = line.match(/^Wikimedia preview ready (.+)$/);
  if (previewReadyMatch) {
    progress.stage = "reviewing";
    progress.currentTitle = previewReadyMatch[1];
    progress.lastPreviewTitle = previewReadyMatch[1];
    progress.message = "Preview ready for review";
    return;
  }

  const previewPendingMatch = line.match(/^Wikimedia preview pending (.+)$/);
  if (previewPendingMatch) {
    progress.stage = "reviewing";
    progress.currentTitle = previewPendingMatch[1];
    progress.lastPreviewTitle = previewPendingMatch[1];
    progress.message = "Preview added to review queue";
    return;
  }

  const previewApprovedMatch = line.match(/^Wikimedia preview approved (.+)$/);
  if (previewApprovedMatch) {
    run.previewDecisionSubmitted = undefined;
    progress.stage = "downloading";
    progress.currentTitle = previewApprovedMatch[1];
    progress.message = "Preview approved; downloading full image";
    return;
  }

  const previewRejectedMatch = line.match(/^Wikimedia preview rejected (.+)$/);
  if (previewRejectedMatch) {
    run.previewDecisionSubmitted = undefined;
    progress.stage = "checking";
    progress.currentTitle = previewRejectedMatch[1];
    progress.message = "Preview rejected; continuing";
    return;
  }

  const previewFailedMatch = line.match(/^Wikimedia preview failed for (.+):/);
  if (previewFailedMatch) {
    progress.lastFailedTitle = previewFailedMatch[1];
    progress.message = "Preview download failed; continuing";
    return;
  }

  const acceptedMatch = line.match(/^Wikimedia accepted (.+)$/);
  if (acceptedMatch) {
    progress.fullDownloads.accepted++;
    progress.stage = "upserting";
    progress.currentTitle = acceptedMatch[1];
    progress.message = "Preparing Postgres upsert";
    return;
  }

  const upsertingTitleMatch = line.match(/^Wikimedia upserting (.+)$/);
  if (upsertingTitleMatch) {
    progress.stage = "upserting";
    progress.currentTitle = upsertingTitleMatch[1];
    progress.message = "Writing metadata to Postgres";
    return;
  }

  const upsertedTitleMatch = line.match(/^Wikimedia upserted (.+)$/);
  if (upsertedTitleMatch) {
    progress.fullDownloads.upserted++;
    progress.stage = "waiting";
    progress.currentTitle = upsertedTitleMatch[1];
    progress.lastUpsertedTitle = upsertedTitleMatch[1];
    progress.message = "Postgres row saved";
    return;
  }

  const downloadFailedMatch = line.match(/^Wikimedia download failed for (.+):/);
  if (downloadFailedMatch) {
    progress.fullDownloads.failed++;
    progress.lastFailedTitle = downloadFailedMatch[1];
    progress.message = "Download failed; continuing";
    return;
  }

  const resizeFailedMatch = line.match(/^Wikimedia resize failed for (.+):/);
  if (resizeFailedMatch) {
    progress.lastFailedTitle = resizeFailedMatch[1];
    progress.message = "Resize failed; continuing";
    return;
  }

  const metadataFailedMatch = line.match(/^Wikimedia metadata failed for (.+)$/);
  if (metadataFailedMatch) {
    progress.lastFailedTitle = metadataFailedMatch[1];
    progress.message = "Metadata failed; continuing";
    return;
  }

  const statsMatch = line.match(/^Wikimedia scrape stats: (\{.*\})$/);
  if (statsMatch) {
    const stats = parseStatsJson(statsMatch[1]);
    if (stats) mergeProgressStats(progress.stats, stats);
    progress.stage = "waiting";
    progress.message = "Scrape run finished";
    return;
  }

  const upsertMatch = line.match(
    /^wikimedia: upserted ([0-9]+) items into Postgres \(([0-9]+) inserted, ([0-9]+) updated\)$/
  );
  if (upsertMatch) {
    progress.stage = "waiting";
    progress.stats.upserted += Number(upsertMatch[1]);
    progress.stats.inserted += Number(upsertMatch[2]);
    progress.stats.updated += Number(upsertMatch[3]);
    progress.message = "Postgres upsert finished";
    return;
  }

  const runFinishedMatch = line.match(
    /^scrape-wikimedia: run ([0-9]+) finished; restarting in ([0-9]+)s$/
  );
  if (runFinishedMatch) {
    progress.stage = "waiting";
    progress.runsCompleted = Math.max(
      progress.runsCompleted,
      Number(runFinishedMatch[1])
    );
    progress.lastCompletedKeyword = progress.currentKeyword;
    progress.lastCompletedAt = now;
    progress.currentTitle = undefined;
    progress.currentUsage = undefined;
    progress.message = `Waiting ${runFinishedMatch[2]}s for next run`;
    return;
  }

  const runPendingMatch = line.match(
    /^scrape-wikimedia: run ([0-9]+) has pending previews; holding offset ([0-9]+); restarting in ([0-9]+)s$/
  );
  if (runPendingMatch) {
    progress.stage = "reviewing";
    progress.runsCompleted = Math.max(
      progress.runsCompleted,
      Number(runPendingMatch[1])
    );
    progress.currentOffset = Number(runPendingMatch[2]);
    progress.message = `Holding offset ${runPendingMatch[2]} for preview review`;
    return;
  }

  const runFailedMatch = line.match(
    /^scrape-wikimedia: run ([0-9]+) exited with ([0-9]+); restarting after failure ([0-9]+) in ([0-9]+)s$/
  );
  if (runFailedMatch) {
    progress.stage = "waiting";
    progress.failures = Number(runFailedMatch[3]);
    progress.message = `Run failed with ${runFailedMatch[2]}; waiting ${runFailedMatch[4]}s`;
  }
}

function parseStatsJson(value: string): Partial<ScraperProgressStats> | undefined {
  let parsed: Record<string, unknown>;

  try {
    parsed = JSON.parse(value) as Record<string, unknown>;
  } catch {
    return undefined;
  }

  if (!parsed || typeof parsed !== "object") return undefined;

  const stats: Partial<ScraperProgressStats> = {};

  for (const key of Object.keys(EMPTY_PROGRESS_STATS) as Array<
    keyof ScraperProgressStats
  >) {
    const value = parsed[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      stats[key] = value;
    }
  }

  return stats;
}

function mergeProgressStats(
  target: ScraperProgressStats,
  next: Partial<ScraperProgressStats>
) {
  for (const key of Object.keys(EMPTY_PROGRESS_STATS) as Array<
    keyof ScraperProgressStats
  >) {
    target[key] += next[key] ?? 0;
  }
}

function finishRun(
  run: ManagedScraperRun,
  code: number | null,
  signal: NodeJS.Signals | null
) {
  run.phase = run.stopRequested ? "exited" : code === 0 ? "exited" : "error";
  run.finishedAt = new Date().toISOString();
  run.exitCode = code;
  run.signal = signal;
  const progress = ensureRunProgress(run);
  progress.stage = run.phase === "error" ? "error" : "finished";
  progress.message = run.stopRequested
    ? "Scraper stopped"
    : run.phase === "error"
      ? "Scraper exited with an error"
      : "Scraper finished";
  progress.updatedAt = run.finishedAt;
  appendLog(
    run,
    "system",
    `Scraper process exited with ${signal ? `signal ${signal}` : `code ${code}`}`
  );
}

function finishRunWithError(run: ManagedScraperRun, message: string) {
  run.phase = "error";
  run.finishedAt = new Date().toISOString();
  run.error = message;
  const progress = ensureRunProgress(run);
  progress.stage = "error";
  progress.message = message;
  progress.updatedAt = run.finishedAt;
  appendLog(run, "system", message);
}

function terminateChild(run: ManagedScraperRun, signal: NodeJS.Signals) {
  const pid = run.pid ?? run.child?.pid;
  if (!pid) return false;

  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    try {
      process.kill(pid, signal);
      return true;
    } catch (error) {
      appendLog(
        run,
        "system",
        error instanceof Error ? error.message : "Failed to stop scraper"
      );
      return false;
    }
  }
}

function buildRunStatus(
  run: ManagedScraperRun | undefined
): Omit<
  ScraperStatusResponse,
  | "coveredKeywords"
  | "keywordCoverage"
  | "suggestions"
  | "previewDecisions"
  | "pendingPreviews"
> {
  if (!run) {
    return {
      phase: "idle",
      running: false,
      progress: createInitialProgress("idle"),
      logs: [],
    };
  }

  const progress = ensureRunProgress(run);
  reconcileProgressWithPhase(run, progress);

  return {
    phase: run.phase,
    running: isActiveRun(run),
    pid: run.pid,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    exitCode: run.exitCode,
    signal: run.signal,
    error: run.error,
    command: run.command,
    scraperRoot: run.scraperRoot,
    config: run.config,
    progress,
    logs: run.logs.slice(-MAX_LOG_LINES),
  };
}

function reconcileProgressWithPhase(
  run: ManagedScraperRun,
  progress: ScraperProgress
) {
  if (isActiveRun(run)) return;

  if (run.phase === "error") {
    progress.stage = "error";
    progress.message = run.error ?? progress.message ?? "Scraper error";
  } else if (run.phase === "exited") {
    progress.stage = "finished";
    progress.message = progress.message?.startsWith("Scraper stopped")
      ? progress.message
      : "Scraper finished";
  } else if (run.phase === "idle") {
    progress.stage = "idle";
    progress.message = "Idle";
  }

  progress.updatedAt = run.finishedAt ?? progress.updatedAt;
}

function isActiveRun(run: ManagedScraperRun) {
  return (
    !run.finishedAt &&
    (run.phase === "building" ||
      run.phase === "running" ||
      run.phase === "stopping")
  );
}

function parseStartConfig(body: unknown): Omit<
  ScraperRunConfig,
  "keywords" | "skippedCoveredKeywords"
> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Invalid scraper request body");
  }

  const record = body as Record<string, unknown>;
  const requestedKeywords = parseKeywordInput(record.keywords);
  if (requestedKeywords.length === 0) {
    throw new Error("Add at least one keyword");
  }

  if (requestedKeywords.length > MAX_KEYWORDS) {
    throw new Error(`Use ${MAX_KEYWORDS} keywords or fewer per run`);
  }

  return {
    requestedKeywords,
    skipCovered: record.skipCovered !== false,
    reviewMode: parseReviewMode(record.reviewMode),
    previewReview: record.previewReview === true,
    previewWidth: parseIntOption(
      record.previewWidth,
      DEFAULT_PREVIEW_WIDTH,
      64,
      1200
    ),
    limit: parseIntOption(record.limit, DEFAULT_LIMIT, 1, 500),
    widths: parseWidthsOption(record.widths, DEFAULT_WIDTHS),
    minGlobalUsage: parseIntOption(record.minGlobalUsage, 0, 0, 10_000),
    minLocalUsage: parseIntOption(record.minLocalUsage, 0, 0, 10_000),
    thumbWidth: parseIntOption(record.thumbWidth, DEFAULT_THUMB_WIDTH, 256, 6000),
    allowDuplicateTitles: record.allowDuplicateTitles === true,
    revisitRejectedPreviews: record.revisitRejectedPreviews === true,
    disableCandidateFilters: record.disableCandidateFilters === true,
    ignoreUsageFilter: record.ignoreUsageFilter === true,
    artFilterMode: parseArtFilterMode(record.artFilterMode),
    fullDownloadConcurrency: parseIntOption(
      record.fullDownloadConcurrency,
      DEFAULT_FULL_DOWNLOAD_CONCURRENCY,
      1,
      8
    ),
    downloadDelayMs: parseIntOption(
      record.downloadDelayMs,
      DEFAULT_DOWNLOAD_DELAY_MS,
      0,
      600_000
    ),
    successDelay: parseIntOption(
      record.successDelay,
      DEFAULT_SUCCESS_DELAY,
      0,
      86_400
    ),
    restartDelay: parseIntOption(
      record.restartDelay,
      DEFAULT_RESTART_DELAY,
      0,
      86_400
    ),
    maxFailures: parseIntOption(record.maxFailures, 0, 0, 10_000),
    refreshExisting: record.refreshExisting === true,
    userAgent:
      typeof record.userAgent === "string" && record.userAgent.trim()
        ? record.userAgent.trim().slice(0, 300)
        : undefined,
  };
}

function parseArtFilterMode(value: unknown): ScraperRunConfig["artFilterMode"] {
  return value === "strict" ? "strict" : "broad";
}

function parseReviewMode(value: unknown): ScraperRunConfig["reviewMode"] {
  if (value === "previews" || value === "full") return value;
  return "both";
}

function parsePreviewRating(value: unknown): 1 | 2 | 3 | 4 | 5 {
  const rating = Number(value);
  if (Number.isInteger(rating) && rating >= 1 && rating <= 5) {
    return rating as 1 | 2 | 3 | 4 | 5;
  }

  throw new Error("Preview rating must be an integer from 1 to 5");
}

function parseKeywordInput(value: unknown) {
  const rawKeywords = Array.isArray(value)
    ? value.flatMap((item) => String(item).split(/[,;|\n]/))
    : typeof value === "string"
      ? value.split(/[,;|\n]/)
      : [];
  const keywords: string[] = [];
  const seen = new Set<string>();

  for (const rawKeyword of rawKeywords) {
    const keyword = rawKeyword.replace(/\s+/g, " ").trim().slice(0, 120);
    const normalized = normalizeKeyword(keyword);
    if (!keyword || !normalized || seen.has(normalized)) continue;

    seen.add(normalized);
    keywords.push(keyword);
  }

  return keywords;
}

function parseIntOption(
  value: unknown,
  fallback: number,
  min: number,
  max: number
) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;

  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function parseWidthsOption(value: unknown, fallback: string) {
  const widths = String(value ?? fallback)
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isInteger(item) && item >= 64 && item <= 6000);

  return Array.from(new Set(widths)).join(",") || fallback;
}

async function loadPreviewDecisionSummary(): Promise<ScraperPreviewDecisionSummary> {
  await ensureArtworkDatabase();

  const [countsResult, pendingResult, recentResult] = await Promise.all([
    getArtworkPool().query<PreviewDecisionCountRow>(
      `SELECT
          wpd.decision,
          COUNT(*) AS "decisionCount",
          COUNT(*) FILTER (WHERE a.id IS NOT NULL) AS "downloadedCount",
          MAX(wpd.decided_at) AS "lastDecidedAt"
       FROM wikimedia_preview_decisions wpd
       LEFT JOIN artworks a ON a.id = wpd.id
       GROUP BY wpd.decision`
    ),
    getArtworkPool().query<PreviewDecisionRecentRow>(
      previewDecisionSelectSql(`
       WHERE wpd.decision = 'pending'
       ORDER BY wpd.created_at ASC
       LIMIT 48`)
    ),
    getArtworkPool().query<PreviewDecisionRecentRow>(
      previewDecisionSelectSql(`
       WHERE wpd.decision <> 'pending'
       ORDER BY wpd.decided_at DESC
       LIMIT 12`)
    ),
  ]);

  const summary = emptyPreviewDecisionSummary();

  for (const row of countsResult.rows) {
    const count = Number(row.decisionCount);
    if (!Number.isFinite(count)) continue;

    if (row.decision === "pending") summary.pendingCount += count;
    if (row.decision === "approved") {
      const downloadedCount = Number(row.downloadedCount);
      const safeDownloadedCount = Number.isFinite(downloadedCount)
        ? downloadedCount
        : 0;
      summary.approvedCount += count;
      summary.approvedDownloadedCount += safeDownloadedCount;
      summary.approvedPendingDownloadCount += Math.max(
        0,
        count - safeDownloadedCount
      );
    }
    if (row.decision === "rejected") summary.rejectedCount += count;
  }

  summary.pending = pendingResult.rows.flatMap(previewFromRow);

  summary.recent = recentResult.rows.flatMap((row) =>
    row.decision === "approved" || row.decision === "rejected"
      ? [
          {
            id: row.id,
            title: row.title,
            decision: row.decision,
            query: row.query ?? undefined,
            decidedAt: row.decidedAt ?? undefined,
            downloaded: row.downloaded === true,
            rating: parseStoredRating(row.rating),
          },
        ]
      : []
  );

  return summary;
}

function emptyPreviewDecisionSummary(): ScraperPreviewDecisionSummary {
  return {
    pendingCount: 0,
    approvedCount: 0,
    approvedDownloadedCount: 0,
    approvedPendingDownloadCount: 0,
    rejectedCount: 0,
    pending: [],
    recent: [],
  };
}

function previewDecisionSelectSql(tailSql: string) {
  return `SELECT
      wpd.id,
      wpd.source_id AS "sourceId",
      wpd.title,
      wpd.decision,
      wpd.search_query AS query,
      wpd.preview_url AS "previewUrl",
      wpd.preview_local_path AS "previewLocalPath",
      wpd.source_url AS "sourceUrl",
      wpd.decided_at AS "decidedAt",
      wpd.metadata_json AS metadata,
      (wpd.metadata_json ->> 'rating')::integer AS rating,
      (a.id IS NOT NULL) AS downloaded
    FROM wikimedia_preview_decisions wpd
    LEFT JOIN artworks a ON a.id = wpd.id
    ${tailSql}`;
}

async function updatePreviewDecision(
  previewId: string,
  decision: Exclude<ScraperPreviewDecision, "pending">,
  decidedAt: string,
  rating: 1 | 2 | 3 | 4 | 5
) {
  await ensureArtworkDatabase();

  const result = await getArtworkPool().query<{ title: string }>(
    `UPDATE wikimedia_preview_decisions
     SET decision = $2,
         decided_at = $3,
         updated_at = $3,
         metadata_json = jsonb_set(
           COALESCE(metadata_json, '{}'::jsonb),
           '{rating}',
           to_jsonb($4::integer),
           true
         )
     WHERE id = $1
       AND decision = 'pending'
     RETURNING title`,
    [previewId, decision, decidedAt, rating]
  );

  const title = result.rows[0]?.title;
  if (!title) {
    throw new Error("Preview is no longer pending");
  }

  return title;
}

async function loadPreviewImagePath(previewId: string) {
  await ensureArtworkDatabase();

  const result = await getArtworkPool().query<{ previewLocalPath: string | null }>(
    `SELECT preview_local_path AS "previewLocalPath"
     FROM wikimedia_preview_decisions
     WHERE id = $1`,
    [previewId]
  );

  return result.rows[0]?.previewLocalPath ?? undefined;
}

function previewFromRow(row: PreviewDecisionRecentRow): ScraperPendingPreview[] {
  if (row.decision !== "pending" || !row.sourceId) return [];

  const metadata =
    row.metadata && typeof row.metadata === "object" ? row.metadata : {};
  const usage = usageValue(metadata.usage);
  const dimensions = dimensionsValue(metadata.dimensions);
  const requestedAt =
    typeof metadata.requestedAt === "string"
      ? metadata.requestedAt
      : row.decidedAt ?? undefined;

  return [
    {
      id: row.id,
      sourceId: row.sourceId,
      title: row.title,
      query: row.query ?? "",
      sourceUrl: row.sourceUrl ?? "",
      previewImageUrl: `/api/scraper?previewImage=${encodeURIComponent(
        row.id
      )}&v=${encodeURIComponent(row.decidedAt ?? row.id)}`,
      remotePreviewUrl: row.previewUrl ?? "",
      license: stringValue(metadata.license),
      licenseUrl: stringValue(metadata.licenseUrl),
      artist: stringValue(metadata.artist),
      date: stringValue(metadata.date),
      description: stringValue(metadata.description),
      usage,
      dimensions,
      requestedAt,
      downloaded: row.downloaded === true,
      rating: parseStoredRating(row.rating),
    },
  ];
}

function parseStoredRating(value: unknown): 1 | 2 | 3 | 4 | 5 | undefined {
  const rating = Number(value);
  if (Number.isInteger(rating) && rating >= 1 && rating <= 5) {
    return rating as 1 | 2 | 3 | 4 | 5;
  }

  return undefined;
}

async function loadCoveredKeywords(paths: ScraperPaths) {
  await ensureArtworkDatabase();

  const rows = (
    await getArtworkPool().query<KeywordRow>(
      `SELECT
          search_query AS keyword,
          COUNT(*) AS "downloadedCount",
          MIN(downloaded_at) AS "firstDownloadedAt",
          MAX(downloaded_at) AS "lastDownloadedAt"
       FROM artworks
       WHERE source = 'wikimedia'
         AND search_query IS NOT NULL
         AND btrim(search_query) <> ''
       GROUP BY search_query
       ORDER BY MAX(downloaded_at) DESC NULLS LAST, COUNT(*) DESC
       LIMIT 500`
    )
  ).rows;

  const byNormalized = new Map<string, CoveredKeyword>();

  for (const row of rows) {
    const keyword = row.keyword?.trim();
    if (!keyword) continue;

    const normalizedKeyword = normalizeKeyword(keyword);
    const downloadedCount = Number(row.downloadedCount);
    const current = byNormalized.get(normalizedKeyword);
    const firstDownloadedAt = minIsoDate(
      current?.firstDownloadedAt,
      row.firstDownloadedAt ?? undefined
    );
    const lastDownloadedAt = maxIsoDate(
      current?.lastDownloadedAt,
      row.lastDownloadedAt ?? undefined
    );

    byNormalized.set(normalizedKeyword, {
      keyword: current?.keyword ?? keyword,
      normalizedKeyword,
      downloadedCount:
        (current?.downloadedCount ?? 0) +
        (Number.isFinite(downloadedCount) ? downloadedCount : 0),
      firstDownloadedAt,
      lastDownloadedAt,
      nextOffset:
        readOffsetForKeyword(paths, keyword) ??
        current?.nextOffset ??
        fallbackOffsetForDownloadedCount(downloadedCount),
    });
  }

  return Array.from(byNormalized.values()).sort(
    (a, b) =>
      (b.lastDownloadedAt ?? "").localeCompare(a.lastDownloadedAt ?? "") ||
      b.downloadedCount - a.downloadedCount ||
      a.keyword.localeCompare(b.keyword)
  );
}

function fallbackOffsetForDownloadedCount(downloadedCount: number) {
  return Number.isFinite(downloadedCount) && downloadedCount > 0
    ? Math.trunc(downloadedCount)
    : undefined;
}

function buildKeywordCoverage(
  requestedKeywords: string[],
  coveredKeywords: CoveredKeyword[]
): KeywordCoverage[] {
  const coveredByNormalized = new Map(
    coveredKeywords.map((keyword) => [keyword.normalizedKeyword, keyword])
  );

  return requestedKeywords.map((requestedKeyword) => {
    const normalizedKeyword = normalizeKeyword(requestedKeyword);
    const covered = coveredByNormalized.get(normalizedKeyword);

    if (covered) {
      return {
        ...covered,
        requestedKeyword,
        status:
          typeof covered.nextOffset === "number" ? "continuable" : "covered",
      };
    }

    return {
      keyword: requestedKeyword,
      requestedKeyword,
      normalizedKeyword,
      downloadedCount: 0,
      status: "new",
    };
  });
}

function isKeywordSkippable(keyword: CoveredKeyword | undefined) {
  return Boolean(keyword && typeof keyword.nextOffset !== "number");
}

function buildKeywordSuggestions(
  coveredKeywords: CoveredKeyword[],
  requestedKeywords: string[] = []
) {
  const covered = new Set(
    coveredKeywords.map((keyword) => keyword.normalizedKeyword)
  );
  const requested = new Set(requestedKeywords.map(normalizeKeyword));

  return SUGGESTION_SEEDS.filter(
    (seed) =>
      !covered.has(normalizeKeyword(seed.keyword)) &&
      !requested.has(normalizeKeyword(seed.keyword))
  )
    .map((seed) => ({ ...seed }))
    .slice(0, 16);
}

function readOffsetForKeyword(paths: ScraperPaths, keyword: string) {
  const offsetDirectory = path.join(paths.scraperRoot, ".wikimedia-search-offsets");
  const exactOffsetPath = path.join(offsetDirectory, offsetKeyForQuery(keyword));
  const exactOffset = readNumberFile(exactOffsetPath);
  if (exactOffset !== undefined) return exactOffset;

  const prefix = `${offsetSlugForQuery(keyword)}-`;
  const matchingFile = fs.existsSync(offsetDirectory)
    ? fs
        .readdirSync(offsetDirectory)
        .find((file) => file.startsWith(prefix))
    : undefined;

  return matchingFile
    ? readNumberFile(path.join(offsetDirectory, matchingFile))
    : undefined;
}

function readNumberFile(filePath: string) {
  if (!fs.existsSync(filePath)) return undefined;

  const value = Number(fs.readFileSync(filePath, "utf8").trim());
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : undefined;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function usageValue(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const global = Number(record.global);
  const local = Number(record.local);

  return Number.isFinite(global) && Number.isFinite(local)
    ? { global, local }
    : undefined;
}

function dimensionsValue(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const width = Number(record.width);
  const height = Number(record.height);

  return {
    width: Number.isFinite(width) ? width : undefined,
    height: Number.isFinite(height) ? height : undefined,
  };
}

function contentTypeForImagePath(filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  return "application/octet-stream";
}

function offsetKeyForQuery(query: string) {
  return `${offsetSlugForQuery(query)}-${posixCksum(query)}`;
}

function offsetSlugForQuery(query: string) {
  return (
    query
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "query"
  );
}

function posixCksum(value: string) {
  let crc = 0;

  for (const byte of Buffer.from(value)) {
    crc = updateCrc(crc, byte);
  }

  let length = Buffer.byteLength(value);
  while (length > 0) {
    crc = updateCrc(crc, length & 0xff);
    length = Math.floor(length / 256);
  }

  return (~crc >>> 0).toString();
}

function updateCrc(crc: number, byte: number) {
  crc ^= byte << 24;

  for (let bit = 0; bit < 8; bit++) {
    crc =
      crc & 0x80000000
        ? ((crc << 1) ^ 0x04c11db7) >>> 0
        : (crc << 1) >>> 0;
  }

  return crc >>> 0;
}

function resolveScraperPaths(): ScraperPaths {
  let current = process.cwd();

  while (true) {
    const scraperRoot = path.join(current, "packages", "scraper");
    const webRoot = path.join(current, "apps", "web");

    if (
      fs.existsSync(path.join(scraperRoot, "package.json")) &&
      fs.existsSync(path.join(scraperRoot, "scripts", "scrape-wikimedia-loop.sh"))
    ) {
      return {
        repoRoot: current,
        scraperRoot,
        webRoot,
      };
    }

    const next = path.dirname(current);
    if (next === current) break;
    current = next;
  }

  throw new Error("Could not find packages/scraper from the web app");
}

function normalizeKeyword(value: string) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function minIsoDate(current: string | undefined, next: string | undefined) {
  if (!current) return next;
  if (!next) return current;
  return next < current ? next : current;
}

function maxIsoDate(current: string | undefined, next: string | undefined) {
  if (!current) return next;
  if (!next) return current;
  return next > current ? next : current;
}
