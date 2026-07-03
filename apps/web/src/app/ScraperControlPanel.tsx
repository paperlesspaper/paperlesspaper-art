"use client";

import Image from "next/image";
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  CoveredKeyword,
  KeywordCoverage,
  KeywordSuggestion,
  ScraperLogLine,
  ScraperPendingPreview,
  ScraperPreviewDecisionSummary,
  ScraperProgress,
  ScraperStatusResponse,
} from "@/lib/scraper-types";
import styles from "./page.module.css";

const DEFAULT_KEYWORDS =
  "landscape paintings, portrait paintings, still life paintings, botanical illustration";

export function ScraperControlPanel() {
  const [status, setStatus] = useState<ScraperStatusResponse>();
  const [keywordsText, setKeywordsText] = useState(DEFAULT_KEYWORDS);
  const [limit, setLimit] = useState("100");
  const [widths, setWidths] = useState("512,1024");
  const [minGlobalUsage, setMinGlobalUsage] = useState("0");
  const [minLocalUsage, setMinLocalUsage] = useState("0");
  const [thumbWidth, setThumbWidth] = useState("2048");
  const [duplicateTitleMode, setDuplicateTitleMode] = useState("skip");
  const [rejectedPreviewMode, setRejectedPreviewMode] = useState("skip");
  const [candidateFilterMode, setCandidateFilterMode] = useState("use");
  const [usageFilterMode, setUsageFilterMode] = useState("use");
  const [artFilterMode, setArtFilterMode] = useState("broad");
  const [fullDownloadConcurrency, setFullDownloadConcurrency] = useState("3");
  const [previewReview, setPreviewReview] = useState(true);
  const [previewWidth, setPreviewWidth] = useState("160");
  const [downloadDelayMs, setDownloadDelayMs] = useState("5000");
  const [successDelay, setSuccessDelay] = useState("30");
  const [restartDelay, setRestartDelay] = useState("10");
  const [maxFailures, setMaxFailures] = useState("0");
  const [skipCovered, setSkipCovered] = useState(true);
  const [refreshExisting, setRefreshExisting] = useState(false);
  const [userAgent, setUserAgent] = useState("");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isDecisionSubmitting, setIsDecisionSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string>();

  const running = status?.running ?? false;
  const locked = running || status?.phase === "building" || status?.phase === "stopping";
  const selectedCoveredCount =
    status?.keywordCoverage.filter((keyword) => keyword.status !== "new")
      .length ?? 0;
  const activeKeywords = status?.config?.keywords ?? [];
  const skippedKeywords = status?.config?.skippedCoveredKeywords ?? [];
  const hasPendingPreview = Boolean(status?.pendingPreviews.length);

  const statusLabel = useMemo(() => {
    if (!status) return "Loading";
    if (status.phase === "idle") return "Idle";
    if (status.phase === "building") return "Building";
    if (status.phase === "running") return "Running";
    if (status.phase === "stopping") return "Stopping";
    if (status.phase === "error") return "Error";
    return "Stopped";
  }, [status]);

  const loadStatus = useCallback(
    async (signal?: AbortSignal) => {
      setIsRefreshing(true);
      try {
        const params = new URLSearchParams();
        if (keywordsText.trim()) params.set("keywords", keywordsText);

        const response = await fetch(`/api/scraper?${params.toString()}`, {
          cache: "no-store",
          headers: { Accept: "application/json" },
          signal,
        });
        const result = (await response.json().catch(() => undefined)) as
          | ScraperStatusResponse
          | { error?: string }
          | undefined;

        if (!response.ok) {
          throw new Error(result?.error ?? `Scraper status failed: ${response.status}`);
        }

        setStatus(result as ScraperStatusResponse);
        setActionError(undefined);
      } catch (error) {
        if (signal?.aborted) return;
        setActionError(
          error instanceof Error ? error.message : "Failed to load scraper status"
        );
      } finally {
        if (!signal?.aborted) setIsRefreshing(false);
      }
    },
    [keywordsText]
  );

  useEffect(() => {
    const abortController = new AbortController();
    const timeoutId = window.setTimeout(
      () => loadStatus(abortController.signal),
      250
    );

    return () => {
      window.clearTimeout(timeoutId);
      abortController.abort();
    };
  }, [loadStatus]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      loadStatus();
    }, hasPendingPreview ? 1500 : running ? 3500 : 12000);

    return () => window.clearInterval(intervalId);
  }, [hasPendingPreview, loadStatus, running]);

  async function submitAction(
    action: "start" | "stop",
    reviewMode: "both" | "previews" | "full" = "both"
  ) {
    setActionError(undefined);
    setIsSubmitting(true);

    try {
      const response = await fetch("/api/scraper", {
        method: "POST",
        cache: "no-store",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action,
          keywords: keywordsText,
          limit,
          widths,
          minGlobalUsage,
          minLocalUsage,
          thumbWidth,
          allowDuplicateTitles: duplicateTitleMode === "allow",
          revisitRejectedPreviews: rejectedPreviewMode === "revisit",
          disableCandidateFilters: candidateFilterMode === "disable",
          ignoreUsageFilter: usageFilterMode === "ignore",
          artFilterMode,
          fullDownloadConcurrency,
          reviewMode,
          previewReview: reviewMode === "both" ? previewReview : true,
          previewWidth,
          downloadDelayMs,
          successDelay,
          restartDelay,
          maxFailures,
          skipCovered,
          refreshExisting,
          userAgent,
        }),
      });
      const result = (await response.json().catch(() => undefined)) as
        | ScraperStatusResponse
        | { error?: string }
        | undefined;

      if (!response.ok) {
        throw new Error(result?.error ?? `Scraper ${action} failed`);
      }

      setStatus(result as ScraperStatusResponse);
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : `Failed to ${action} scraper`
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  async function submitPreviewDecision(
    previewId: string,
    rating: 1 | 2 | 3 | 4 | 5
  ) {
    const pendingPreview = status?.pendingPreviews.find(
      (preview) => preview.id === previewId
    );
    if (!pendingPreview) return;

    setActionError(undefined);
    setIsDecisionSubmitting(true);

    try {
      const response = await fetch("/api/scraper", {
        method: "POST",
        cache: "no-store",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: "previewDecision",
          previewId,
          rating,
        }),
      });
      const result = (await response.json().catch(() => undefined)) as
        | ScraperStatusResponse
        | { error?: string }
        | undefined;

      if (!response.ok) {
        throw new Error(result?.error ?? "Preview decision failed");
      }

      setStatus(result as ScraperStatusResponse);
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : "Failed to submit preview decision"
      );
    } finally {
      setIsDecisionSubmitting(false);
    }
  }

  function addKeyword(keyword: string) {
    setKeywordsText((current) => {
      const currentKeywords = parseKeywords(current);
      const normalized = normalizeKeyword(keyword);
      if (
        currentKeywords.some(
          (currentKeyword) => normalizeKeyword(currentKeyword) === normalized
        )
      ) {
        return current;
      }

      return [...currentKeywords, keyword].join(", ");
    });
  }

  function useNextSuggestions() {
    const nextKeywords = (status?.suggestions ?? [])
      .slice(0, 4)
      .map((suggestion) => suggestion.keyword);

    if (nextKeywords.length > 0) setKeywordsText(nextKeywords.join(", "));
  }

  return (
    <section className={styles.scraperPanel} aria-label="Wikimedia scraper">
      <div className={styles.scraperPanelHeader}>
        <div>
          <h2>Wikimedia scraper</h2>
          <p>
            {status?.pid ? `PID ${status.pid}` : "Local controller"} ·{" "}
            {status?.scraperRoot ?? "packages/scraper"}
          </p>
        </div>
        <span
          className={
            running || status?.phase === "building"
              ? `${styles.scraperStatusBadge} ${styles.scraperStatusBadgeActive}`
              : styles.scraperStatusBadge
          }
        >
          {statusLabel}
        </span>
      </div>

      <div className={styles.scraperForm}>
        <label className={styles.scraperKeywordsField}>
          <span>Keywords</span>
          <textarea
            value={keywordsText}
            onChange={(event) => setKeywordsText(event.target.value)}
            disabled={locked}
            rows={4}
          />
        </label>

        <div className={styles.scraperOptionsGrid}>
          <NumberField
            label="Limit"
            value={limit}
            disabled={locked}
            onChange={setLimit}
          />
          <TextField
            label="Widths"
            value={widths}
            disabled={locked}
            onChange={setWidths}
          />
          <NumberField
            label="Thumb"
            value={thumbWidth}
            disabled={locked}
            onChange={setThumbWidth}
          />
          <NumberField
            label="Preview"
            value={previewWidth}
            disabled={locked || !previewReview}
            onChange={setPreviewWidth}
          />
          <NumberField
            label="Download ms"
            value={downloadDelayMs}
            disabled={locked}
            onChange={setDownloadDelayMs}
          />
          <NumberField
            label="Full dl"
            value={fullDownloadConcurrency}
            disabled={locked}
            onChange={setFullDownloadConcurrency}
          />
          <NumberField
            label="Success sec"
            value={successDelay}
            disabled={locked}
            onChange={setSuccessDelay}
          />
          <NumberField
            label="Retry sec"
            value={restartDelay}
            disabled={locked}
            onChange={setRestartDelay}
          />
          <NumberField
            label="Global use"
            value={minGlobalUsage}
            disabled={locked}
            onChange={setMinGlobalUsage}
          />
          <NumberField
            label="Local use"
            value={minLocalUsage}
            disabled={locked}
            onChange={setMinLocalUsage}
          />
          <NumberField
            label="Max fails"
            value={maxFailures}
            disabled={locked}
            onChange={setMaxFailures}
          />
          <SelectField
            label="Duplicate titles"
            value={duplicateTitleMode}
            disabled={locked}
            onChange={setDuplicateTitleMode}
            options={[
              ["skip", "Skip similar"],
              ["allow", "Allow similar"],
            ]}
          />
          <SelectField
            label="Skipped previews"
            value={rejectedPreviewMode}
            disabled={locked}
            onChange={setRejectedPreviewMode}
            options={[
              ["skip", "Hide rating 1"],
              ["revisit", "Show rating 1"],
            ]}
          />
          <SelectField
            label="Candidate filter"
            value={candidateFilterMode}
            disabled={locked}
            onChange={setCandidateFilterMode}
            options={[
              ["use", "Use filters"],
              ["disable", "Disable filters"],
            ]}
          />
          <SelectField
            label="Usage filter"
            value={usageFilterMode}
            disabled={locked || candidateFilterMode === "disable"}
            onChange={setUsageFilterMode}
            options={[
              ["use", "Use threshold"],
              ["ignore", "Ignore usage"],
            ]}
          />
          <SelectField
            label="Art filter"
            value={artFilterMode}
            disabled={locked || candidateFilterMode === "disable"}
            onChange={setArtFilterMode}
            options={[
              ["broad", "Broad"],
              ["strict", "Strict hints"],
            ]}
          />
        </div>

        <label className={styles.scraperUserAgentField}>
          <span>User agent</span>
          <input
            value={userAgent}
            onChange={(event) => setUserAgent(event.target.value)}
            disabled={locked}
            placeholder="paperlesspaper-art/0.1 (contact)"
          />
        </label>

        <div className={styles.scraperCheckboxes}>
          <label>
            <input
              type="checkbox"
              checked={previewReview}
              disabled={locked}
              onChange={(event) => setPreviewReview(event.target.checked)}
            />
            <span>Preview review gate</span>
          </label>
          <label>
            <input
              type="checkbox"
              checked={skipCovered}
              disabled={locked}
              onChange={(event) => setSkipCovered(event.target.checked)}
            />
            <span>Skip covered keywords</span>
          </label>
          <label>
            <input
              type="checkbox"
              checked={refreshExisting}
              disabled={locked}
              onChange={(event) => setRefreshExisting(event.target.checked)}
            />
            <span>Refresh existing artworks</span>
          </label>
        </div>
      </div>

      <div className={styles.scraperActions}>
        <button
          type="button"
          onClick={() => submitAction("start", "previews")}
          disabled={locked || isSubmitting}
        >
          Start previews
        </button>
        <button
          type="button"
          onClick={() => submitAction("start", "full")}
          disabled={locked || isSubmitting}
        >
          Start full downloads
        </button>
        <button
          type="button"
          onClick={() => submitAction("start", "both")}
          disabled={locked || isSubmitting}
        >
          Start both
        </button>
        <button
          type="button"
          onClick={() => submitAction("stop")}
          disabled={!running || isSubmitting || status?.config?.reviewMode === "full"}
        >
          Stop previews
        </button>
        <button
          type="button"
          onClick={() => submitAction("stop")}
          disabled={
            !running || isSubmitting || status?.config?.reviewMode === "previews"
          }
        >
          Stop full downloads
        </button>
        <button
          type="button"
          onClick={() => loadStatus()}
          disabled={isRefreshing || isSubmitting}
        >
          Refresh
        </button>
        <button
          type="button"
          onClick={useNextSuggestions}
          disabled={locked || (status?.suggestions.length ?? 0) === 0}
        >
          Use next hints
        </button>
        <span aria-live="polite">
          {selectedCoveredCount > 0
            ? `${selectedCoveredCount} selected seen before`
            : null}
        </span>
      </div>

      {actionError ? (
        <p className={styles.scraperError}>{actionError}</p>
      ) : status?.databaseError ? (
        <p className={styles.scraperError}>{status.databaseError}</p>
      ) : null}

      {activeKeywords.length > 0 || skippedKeywords.length > 0 ? (
        <div className={styles.scraperRunSummary}>
          {status?.config?.reviewMode ? (
            <span>
              Mode:{" "}
              {status.config.reviewMode === "previews"
                ? "previews only"
                : status.config.reviewMode === "full"
                  ? "full downloads only"
                  : "previews and full downloads"}
            </span>
          ) : null}
          {activeKeywords.length > 0 ? (
            <span>Running: {activeKeywords.join(", ")}</span>
          ) : null}
          {skippedKeywords.length > 0 ? (
            <span>Skipped: {skippedKeywords.join(", ")}</span>
          ) : null}
        </div>
      ) : null}

      <PendingPreviewPanel
        previews={status?.pendingPreviews ?? []}
        disabled={isDecisionSubmitting}
        onDecision={submitPreviewDecision}
      />

      <ScraperProgressPanel
        progress={status?.progress}
        fullDownloadConcurrency={status?.config?.fullDownloadConcurrency}
        previewSummary={status?.previewDecisions}
      />

      <div className={styles.scraperInsightsGrid}>
        <KeywordCoveragePanel keywords={status?.keywordCoverage ?? []} />
        <CoveredKeywordPanel keywords={status?.coveredKeywords ?? []} />
        <PreviewDecisionPanel
          summary={
            status?.previewDecisions ?? {
              pendingCount: 0,
              approvedCount: 0,
              approvedDownloadedCount: 0,
              approvedPendingDownloadCount: 0,
              rejectedCount: 0,
              pending: [],
              recent: [],
            }
          }
        />
        <SuggestionPanel
          suggestions={status?.suggestions ?? []}
          onAddKeyword={addKeyword}
        />
      </div>

      <ScraperLog lines={status?.logs ?? []} />
    </section>
  );
}

function ScraperProgressPanel({
  progress,
  fullDownloadConcurrency = 1,
  previewSummary,
}: {
  progress?: ScraperProgress;
  fullDownloadConcurrency?: number;
  previewSummary?: ScraperPreviewDecisionSummary;
}) {
  const stats = progress?.stats;
  const fullDownloads = progress?.fullDownloads;
  const approvedDownloaded = previewSummary?.approvedDownloadedCount ?? 0;
  const approvedTotal = previewSummary?.approvedCount ?? 0;
  const approvedPending = previewSummary?.approvedPendingDownloadCount ?? 0;
  const totalSkipped = stats
    ? stats.skippedExisting +
      stats.skippedPreviewDownload +
      stats.skippedPreviewRejected +
      stats.skippedDownload +
      stats.skippedLicense +
      stats.skippedNonArt +
      stats.skippedUsage +
      stats.skippedType +
      stats.skippedResize +
      stats.skippedMetadata +
      stats.skippedNoImageInfo +
      stats.skippedNoImageUrl +
      stats.skippedDuplicateTitle
    : 0;

  return (
    <section className={styles.scraperProgressPanel}>
      <div className={styles.scraperProgressHeader}>
        <h3>Current status</h3>
        <span>{progress ? titleCase(progress.stage) : "Idle"}</span>
      </div>

      <div className={styles.scraperProgressCards}>
        <ProgressCard
          label="Run"
          value={
            progress?.currentRun
              ? `${progress.currentRun}`
              : progress?.runsStarted
                ? `${progress.runsStarted}`
                : "-"
          }
          detail={`${progress?.runsCompleted ?? 0} completed`}
        />
        <ProgressCard
          label="Keyword"
          value={progress?.currentKeyword ?? "-"}
          detail={
            typeof progress?.currentOffset === "number"
              ? `offset ${progress.currentOffset}`
              : "waiting"
          }
        />
        <ProgressCard
          label="Accepted"
          value={String(stats?.accepted ?? 0)}
          detail={`${stats?.pages ?? 0} pages inspected`}
        />
        <ProgressCard
          label="Postgres"
          value={String(stats?.upserted ?? 0)}
          detail={`${stats?.inserted ?? 0} inserted · ${stats?.updated ?? 0} updated`}
        />
        <ProgressCard
          label="Full downloads"
          value={`${approvedDownloaded}/${approvedTotal}`}
          detail={
            approvedTotal > 0
              ? `${approvedPending} approved previews waiting · x${
                  fullDownloads?.concurrency ?? fullDownloadConcurrency
                }`
              : `0 approved previews · x${
                  fullDownloads?.concurrency ?? fullDownloadConcurrency
                }`
          }
        />
        <ProgressCard
          label="Full run"
          value={
            fullDownloads?.total
              ? `${fullDownloads.upserted}/${fullDownloads.total}`
              : "-"
          }
          detail={
            fullDownloads?.total
              ? `${fullDownloads.downloaded} downloaded · ${fullDownloads.failed} failed`
              : "no full batch active"
          }
        />
        <ProgressCard
          label="Skipped"
          value={String(totalSkipped)}
          detail={`${stats?.skippedExisting ?? 0} existing · ${
            stats?.skippedDownload ?? 0
          } download failed`}
        />
        <ProgressCard
          label="Failures"
          value={String(progress?.failures ?? 0)}
          detail={formatUpdatedAt(progress?.updatedAt)}
        />
      </div>

      <div className={styles.scraperProgressDetails}>
        <DetailLine label="Status" value={progress?.message ?? "Idle"} />
        <DetailLine
          label="Full batch"
          value={
            fullDownloads?.total
              ? `${fullDownloads.upserted}/${fullDownloads.total} saved · ${fullDownloads.started} started · ${fullDownloads.downloaded} downloaded · ${fullDownloads.accepted} resized · ${fullDownloads.failed} failed · x${fullDownloads.concurrency}`
              : undefined
          }
        />
        <DetailLine
          label="Approved previews"
          value={`${approvedDownloaded}/${approvedTotal} downloaded${
            approvedPending ? ` · ${approvedPending} waiting` : ""
          }`}
        />
        <DetailLine label="Current file" value={progress?.currentTitle} />
        <DetailLine
          label="Usage"
          value={
            progress?.currentUsage
              ? `${progress.currentUsage.global} global · ${progress.currentUsage.local} local`
              : undefined
          }
        />
        <DetailLine label="Last preview" value={progress?.lastPreviewTitle} />
        <DetailLine
          label="Last downloaded"
          value={progress?.lastDownloadedTitle}
        />
        <DetailLine label="Last saved" value={progress?.lastUpsertedTitle} />
        <DetailLine label="Last failed" value={progress?.lastFailedTitle} />
        <DetailLine
          label="Last completed"
          value={
            progress?.lastCompletedKeyword
              ? `${progress.lastCompletedKeyword} · ${formatDateTime(
                  progress.lastCompletedAt
                )}`
              : undefined
          }
        />
      </div>
    </section>
  );
}

function PendingPreviewPanel({
  previews,
  disabled,
  onDecision,
}: {
  previews: ScraperPendingPreview[];
  disabled: boolean;
  onDecision: (previewId: string, rating: 1 | 2 | 3 | 4 | 5) => void;
}) {
  if (previews.length === 0) return null;

  return (
    <section className={styles.scraperPreviewPanel}>
      <div className={styles.scraperPreviewPanelHeader}>
        <h3>Pending previews ({previews.length})</h3>
        <span>Review queue</span>
      </div>
      <div className={styles.scraperPreviewGrid}>
        {previews.map((preview) => (
          <article key={preview.id} className={styles.scraperPreviewCard}>
            <div className={styles.scraperPreviewImageFrame}>
              <Image
                src={preview.previewImageUrl}
                alt={preview.title}
                fill
                sizes="(max-width: 760px) 50vw, 180px"
                unoptimized
              />
            </div>
            <div className={styles.scraperPreviewDetails}>
              <div className={styles.scraperPreviewHeader}>
                <span>{preview.query}</span>
                <strong>{preview.title}</strong>
                <small>{preview.artist ?? preview.date ?? preview.license}</small>
              </div>
              <span
                className={
                  preview.downloaded
                    ? styles.scraperDownloadBadgeDownloaded
                    : styles.scraperDownloadBadge
                }
              >
                {preview.downloaded ? "Downloaded" : "Not downloaded"}
              </span>
              <div className={styles.scraperPreviewMeta}>
                <DetailLine
                  label="Usage"
                  value={
                    preview.usage
                      ? `${preview.usage.global} · ${preview.usage.local}`
                      : undefined
                  }
                />
                <DetailLine
                  label="Size"
                  value={
                    preview.dimensions?.width && preview.dimensions.height
                      ? `${preview.dimensions.width} × ${preview.dimensions.height}`
                      : undefined
                  }
                />
              </div>
              <div
                className={`${styles.ratingGroup} ${styles.scraperPreviewRatingGroup}`}
                aria-label="Preview rating"
              >
                {([1, 2, 3, 4, 5] as const).map((rating) => (
                  <button
                    key={rating}
                    type="button"
                    className={styles.ratingButton}
                    onClick={() => onDecision(preview.id, rating)}
                    disabled={disabled}
                    aria-label={
                      rating === 1
                        ? "Rate 1 and skip download"
                        : `Rate ${rating} and download`
                    }
                  >
                    {rating}
                  </button>
                ))}
              </div>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function ProgressCard({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className={styles.scraperProgressCard}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}

function DetailLine({
  label,
  value,
}: {
  label: string;
  value?: string;
}) {
  if (!value) return null;

  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function TextField({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label className={styles.scraperField}>
      <span>{label}</span>
      <input
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function NumberField(props: {
  label: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label className={styles.scraperField}>
      <span>{props.label}</span>
      <input
        type="number"
        inputMode="numeric"
        min="0"
        value={props.value}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.value)}
      />
    </label>
  );
}

function SelectField(props: {
  label: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
  options: Array<[value: string, label: string]>;
}) {
  return (
    <label className={styles.scraperField}>
      <span>{props.label}</span>
      <select
        value={props.value}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.value)}
      >
        {props.options.map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
    </label>
  );
}

function KeywordCoveragePanel({ keywords }: { keywords: KeywordCoverage[] }) {
  return (
    <section className={styles.scraperInsightPanel}>
      <h3>Selected keywords</h3>
      {keywords.length === 0 ? (
        <p>No keywords selected.</p>
      ) : (
        <div className={styles.scraperKeywordRows}>
          {keywords.map((keyword) => (
            <KeywordRow
              key={keyword.requestedKeyword}
              keyword={keyword.requestedKeyword}
              count={keyword.downloadedCount}
              meta={
                keyword.status === "covered"
                  ? `covered${formatOffset(keyword.nextOffset)}`
                  : keyword.status === "continuable"
                    ? `continue${formatOffset(keyword.nextOffset)}`
                  : "new"
              }
              covered={keyword.status !== "new"}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function CoveredKeywordPanel({ keywords }: { keywords: CoveredKeyword[] }) {
  return (
    <section className={styles.scraperInsightPanel}>
      <h3>Covered keywords ({keywords.length})</h3>
      {keywords.length === 0 ? (
        <p>No Wikimedia keywords downloaded yet.</p>
      ) : (
        <>
          <div
            className={`${styles.scraperKeywordRows} ${styles.scraperKeywordRowsScrollable}`}
          >
            {keywords.slice(0, 48).map((keyword) => (
              <KeywordRow
                key={keyword.normalizedKeyword}
                keyword={keyword.keyword}
                count={keyword.downloadedCount}
                meta={`${formatDate(keyword.lastDownloadedAt)}${formatOffset(
                  keyword.nextOffset
                )}`}
                covered
              />
            ))}
          </div>
          {keywords.length > 48 ? <p>Showing 48 most recent.</p> : null}
        </>
      )}
    </section>
  );
}

function PreviewDecisionPanel({
  summary,
}: {
  summary: ScraperPreviewDecisionSummary;
}) {
  return (
    <section className={styles.scraperInsightPanel}>
      <h3>Preview decisions</h3>
      <div className={styles.scraperDecisionTotals}>
        <span>
          <strong>{summary.pendingCount}</strong>
          pending
        </span>
        <span>
          <strong>{summary.approvedCount}</strong>
          download
        </span>
        <span>
          <strong>
            {summary.approvedDownloadedCount}/{summary.approvedCount}
          </strong>
          full
        </span>
        <span>
          <strong>{summary.rejectedCount}</strong>
          skipped
        </span>
      </div>
      {summary.recent.length === 0 ? (
        <p>No preview decisions yet.</p>
      ) : (
        <div className={styles.scraperKeywordRows}>
          {summary.recent.slice(0, 8).map((decision) => (
            <KeywordRow
              key={decision.id}
              keyword={decision.title}
              count={
                decision.rating
                  ? `rating ${decision.rating}`
                  : decision.decision === "approved"
                    ? "download"
                    : "skip"
              }
              meta={`${decision.downloaded ? "downloaded" : "not downloaded"} · ${
                decision.query ?? "reviewed"
              }`}
              covered={decision.downloaded}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function SuggestionPanel({
  suggestions,
  onAddKeyword,
}: {
  suggestions: KeywordSuggestion[];
  onAddKeyword: (keyword: string) => void;
}) {
  return (
    <section className={styles.scraperInsightPanel}>
      <h3>Next keyword hints</h3>
      {suggestions.length === 0 ? (
        <p>The starter hint list is already covered.</p>
      ) : (
        <div className={styles.scraperSuggestionList}>
          {suggestions.slice(0, 10).map((suggestion) => (
            <button
              key={suggestion.keyword}
              type="button"
              onClick={() => onAddKeyword(suggestion.keyword)}
              title={suggestion.reason}
            >
              <span>
                <strong>{suggestion.keyword}</strong>
                <small>{suggestion.reason}</small>
              </span>
              <em>{suggestion.source}</em>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function KeywordRow({
  keyword,
  count,
  meta,
  covered,
}: {
  keyword: string;
  count: number | string;
  meta: string;
  covered: boolean;
}) {
  return (
    <div className={styles.scraperKeywordRow}>
      <span>{keyword}</span>
      <strong>{count}</strong>
      <small className={covered ? styles.scraperCoveredText : ""}>{meta}</small>
    </div>
  );
}

function ScraperLog({ lines }: { lines: ScraperLogLine[] }) {
  return (
    <section className={styles.scraperLogPanel}>
      <h3>Recent scraper log</h3>
      {lines.length === 0 ? (
        <p>No scraper output yet.</p>
      ) : (
        <pre>
          {lines
            .slice(-40)
            .map((line) => `[${line.stream}] ${line.line}`)
            .join("\n")}
        </pre>
      )}
    </section>
  );
}

function parseKeywords(value: string) {
  return value
    .split(/[,;|\n]/)
    .map((keyword) => keyword.replace(/\s+/g, " ").trim())
    .filter(Boolean);
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

function formatDate(value?: string) {
  if (!value) return "downloaded";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "downloaded";

  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatOffset(offset?: number) {
  return typeof offset === "number" ? ` · next ${offset}` : "";
}

function formatDateTime(value?: string) {
  if (!value) return "";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  return date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatUpdatedAt(value?: string) {
  const formatted = formatDateTime(value);
  return formatted ? `updated ${formatted}` : "not updated";
}

function titleCase(value: string) {
  return value
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
