export type ScraperRunPhase =
  | "idle"
  | "building"
  | "running"
  | "stopping"
  | "exited"
  | "error";

export type ScraperRunConfig = {
  requestedKeywords: string[];
  keywords: string[];
  skippedCoveredKeywords: string[];
  skipCovered: boolean;
  reviewMode: "both" | "previews" | "full";
  previewReview: boolean;
  previewWidth: number;
  limit: number;
  widths: string;
  minGlobalUsage: number;
  minLocalUsage: number;
  thumbWidth: number;
  allowDuplicateTitles: boolean;
  revisitRejectedPreviews: boolean;
  disableCandidateFilters: boolean;
  ignoreUsageFilter: boolean;
  artFilterMode: "broad" | "strict";
  fullDownloadConcurrency: number;
  downloadDelayMs: number;
  successDelay: number;
  restartDelay: number;
  maxFailures: number;
  refreshExisting: boolean;
  userAgent?: string;
};

export type ScraperLogLine = {
  stream: "stdout" | "stderr" | "system";
  timestamp: string;
  line: string;
};

export type ScraperProgressStats = {
  pages: number;
  accepted: number;
  previewed: number;
  previewPending: number;
  previewApproved: number;
  previewRejected: number;
  inserted: number;
  updated: number;
  upserted: number;
  skippedExisting: number;
  skippedPreviewDownload: number;
  skippedPreviewPending: number;
  skippedPreviewRejected: number;
  skippedPreviewApproved: number;
  skippedDownload: number;
  skippedLicense: number;
  skippedNonArt: number;
  skippedUsage: number;
  skippedType: number;
  skippedResize: number;
  skippedMetadata: number;
  skippedNoImageInfo: number;
  skippedNoImageUrl: number;
  skippedDuplicateTitle: number;
};

export type ScraperProgress = {
  stage:
    | "idle"
    | "building"
    | "starting"
    | "searching"
    | "checking"
    | "downloading"
    | "reviewing"
    | "resizing"
    | "upserting"
    | "waiting"
    | "stopping"
    | "finished"
    | "error";
  message?: string;
  currentRun?: number;
  currentKeyword?: string;
  currentOffset?: number;
  currentTitle?: string;
  currentUsage?: {
    global: number;
    local: number;
  };
  lastPreviewTitle?: string;
  lastDownloadedTitle?: string;
  lastUpsertedTitle?: string;
  lastFailedTitle?: string;
  lastCompletedKeyword?: string;
  lastCompletedAt?: string;
  runsStarted: number;
  runsCompleted: number;
  failures: number;
  fullDownloads: {
    total: number;
    queued: number;
    started: number;
    downloaded: number;
    accepted: number;
    upserted: number;
    failed: number;
    concurrency: number;
  };
  stats: ScraperProgressStats;
  updatedAt?: string;
};

export type CoveredKeyword = {
  keyword: string;
  normalizedKeyword: string;
  downloadedCount: number;
  firstDownloadedAt?: string;
  lastDownloadedAt?: string;
  nextOffset?: number;
};

export type KeywordCoverage = CoveredKeyword & {
  requestedKeyword: string;
  status: "covered" | "continuable" | "new";
};

export type KeywordSuggestion = {
  keyword: string;
  reason: string;
  source: "starter" | "gap" | "related";
};

export type ScraperPreviewDecision = "pending" | "approved" | "rejected";

export type ScraperPendingPreview = {
  id: string;
  sourceId: string;
  title: string;
  query: string;
  sourceUrl: string;
  previewImageUrl: string;
  remotePreviewUrl: string;
  license?: string;
  licenseUrl?: string;
  artist?: string;
  date?: string;
  description?: string;
  usage?: {
    global: number;
    local: number;
  };
  dimensions?: {
    width?: number;
    height?: number;
  };
  requestedAt?: string;
  downloaded: boolean;
  rating?: 1 | 2 | 3 | 4 | 5;
  decisionSubmitted?: Exclude<ScraperPreviewDecision, "pending">;
};

export type ScraperPreviewDecisionSummary = {
  pendingCount: number;
  approvedCount: number;
  approvedDownloadedCount: number;
  approvedPendingDownloadCount: number;
  rejectedCount: number;
  pending: ScraperPendingPreview[];
  recent: Array<{
    id: string;
    title: string;
    decision: ScraperPreviewDecision;
    query?: string;
    decidedAt?: string;
    downloaded: boolean;
    rating?: 1 | 2 | 3 | 4 | 5;
  }>;
};

export type ScraperStatusResponse = {
  phase: ScraperRunPhase;
  running: boolean;
  pid?: number;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  error?: string;
  command?: "build" | "scrape";
  scraperRoot?: string;
  config?: ScraperRunConfig;
  progress?: ScraperProgress;
  pendingPreview?: ScraperPendingPreview;
  pendingPreviews: ScraperPendingPreview[];
  previewDecisions: ScraperPreviewDecisionSummary;
  coveredKeywords: CoveredKeyword[];
  keywordCoverage: KeywordCoverage[];
  suggestions: KeywordSuggestion[];
  logs: ScraperLogLine[];
  databaseError?: string;
};
