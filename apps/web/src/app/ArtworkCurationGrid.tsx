"use client";

import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { Artwork, ArtworkApiItem, ArtworkCatalogMeta } from "@/lib/artworks";
import type {
  ArtworkCuration,
  ArtworkCurationItem,
} from "@/lib/artwork-curation";
import styles from "./page.module.css";

type Props = {
  readOnlyCuration: boolean;
};

type SaveStatus = "idle" | "saving" | "saved" | "error";
type SourceFilter = "all" | Artwork["source"];
type HighlightFilter = "all" | "highlighted" | "not-highlighted";
type RatingFilter = "all" | "rated" | "unrated" | "1" | "2" | "3" | "4" | "5";
type UrlFilters = {
  query: string;
  sourceFilter: SourceFilter;
  highlightFilter: HighlightFilter;
  ratingFilter: RatingFilter;
  page: number;
  pageSize: number;
};

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 60;
const PAGE_SIZE_OPTIONS = [40, 60, 100, 160];
const ARTWORK_SOURCES: Array<Artwork["source"]> = [
  "artic",
  "met",
  "svgrepo",
  "wikimedia",
];
const EMPTY_META: ArtworkCatalogMeta = {
  totalCatalogItems: 0,
  sourceCounts: {},
  sources: [],
  curation: {
    highlighted: 0,
    rated: 0,
  },
};

export function ArtworkCurationGrid({ readOnlyCuration }: Props) {
  const [artworks, setArtworks] = useState<ArtworkApiItem[]>([]);
  const [curation, setCuration] = useState<ArtworkCuration>({});
  const [catalogMeta, setCatalogMeta] =
    useState<ArtworkCatalogMeta>(EMPTY_META);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string>();
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [query, setQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [highlightFilter, setHighlightFilter] =
    useState<HighlightFilter>("all");
  const [ratingFilter, setRatingFilter] = useState<RatingFilter>("all");
  const [page, setPage] = useState(DEFAULT_PAGE);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [selectedArtworkId, setSelectedArtworkId] = useState<string>();
  const [copiedRequest, setCopiedRequest] = useState<string>();
  const [hasLoadedUrlFilters, setHasLoadedUrlFilters] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);

  const stats = catalogMeta.curation;

  const sourceOptions = useMemo(() => {
    const fromMeta =
      catalogMeta.sources.length > 0
        ? catalogMeta.sources
        : ARTWORK_SOURCES;
    return Array.from(new Set(fromMeta)).sort();
  }, [catalogMeta]);

  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(page, pageCount);
  const pageStart = (currentPage - 1) * pageSize;
  const pageEnd = Math.min(pageStart + artworks.length, total);
  const pageArtworks = artworks;
  const selectedArtwork = selectedArtworkId
    ? pageArtworks.find((artwork) => artwork.id === selectedArtworkId)
    : undefined;
  const selectedIndex = selectedArtwork
    ? pageArtworks.findIndex((artwork) => artwork.id === selectedArtwork.id)
    : -1;
  const listApiPath = useMemo(
    () =>
      buildArtworkListApiPath({
        query,
        sourceFilter,
        highlightFilter,
        ratingFilter,
        pageSize,
        offset: pageStart,
      }),
    [highlightFilter, pageSize, pageStart, query, ratingFilter, sourceFilter]
  );
  const listCurl = useMemo(() => toCurlRequest(listApiPath), [listApiPath]);

  const hasActiveFilters =
    query.length > 0 ||
    sourceFilter !== "all" ||
    highlightFilter !== "all" ||
    ratingFilter !== "all" ||
    currentPage !== DEFAULT_PAGE ||
    pageSize !== DEFAULT_PAGE_SIZE;

  useEffect(() => {
    const filters = readUrlFilters();
    setQuery(filters.query);
    setSourceFilter(filters.sourceFilter);
    setHighlightFilter(filters.highlightFilter);
    setRatingFilter(filters.ratingFilter);
    setPage(filters.page);
    setPageSize(filters.pageSize);
    setHasLoadedUrlFilters(true);
  }, []);

  useEffect(() => {
    if (!hasLoadedUrlFilters) return;

    const abortController = new AbortController();

    async function loadPage() {
      setIsLoading(true);
      setLoadError(undefined);

      try {
        const response = await fetch(listApiPath, {
          headers: { Accept: "application/json" },
          signal: abortController.signal,
        });

        if (!response.ok) {
          throw new Error(`Artwork request failed: ${response.status}`);
        }

        const result = (await response.json()) as {
          items?: ArtworkApiItem[];
          total?: number;
          meta?: ArtworkCatalogMeta;
        };
        const nextItems = Array.isArray(result.items) ? result.items : [];

        setArtworks(nextItems);
        setTotal(typeof result.total === "number" ? result.total : 0);
        setCatalogMeta(result.meta ?? EMPTY_META);
        setCuration(pageCurationFromItems(nextItems));
      } catch (error) {
        if (abortController.signal.aborted) return;
        setArtworks([]);
        setTotal(0);
        setLoadError(
          error instanceof Error ? error.message : "Failed to load artworks"
        );
      } finally {
        if (!abortController.signal.aborted) setIsLoading(false);
      }
    }

    loadPage();

    return () => abortController.abort();
  }, [hasLoadedUrlFilters, listApiPath, refreshToken]);

  useEffect(() => {
    if (!hasLoadedUrlFilters) return;

    writeUrlFilters({
      query,
      sourceFilter,
      highlightFilter,
      ratingFilter,
      page: currentPage,
      pageSize,
    });
  }, [
    currentPage,
    hasLoadedUrlFilters,
    highlightFilter,
    pageSize,
    query,
    ratingFilter,
    sourceFilter,
  ]);

  useEffect(() => {
    if (page > pageCount) setPage(pageCount);
  }, [page, pageCount]);

  useEffect(() => {
    if (!selectedArtworkId) return;
    if (!pageArtworks.some((artwork) => artwork.id === selectedArtworkId)) {
      setSelectedArtworkId(undefined);
    }
  }, [pageArtworks, selectedArtworkId]);

  useEffect(() => {
    if (!selectedArtwork) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setSelectedArtworkId(undefined);
      }

      if (event.key === "ArrowLeft" && selectedIndex > 0) {
        setSelectedArtworkId(pageArtworks[selectedIndex - 1].id);
      }

      if (
        event.key === "ArrowRight" &&
        selectedIndex < pageArtworks.length - 1
      ) {
        setSelectedArtworkId(pageArtworks[selectedIndex + 1].id);
      }
    }

    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [pageArtworks, selectedArtwork, selectedIndex]);

  async function saveItem(id: string, nextItem: ArtworkCurationItem) {
    if (readOnlyCuration) return;

    const previousItem = curation[id];
    const payload: {
      id: string;
      highlighted?: boolean;
      rating?: ArtworkCurationItem["rating"] | null;
    } = { id };

    if ("highlighted" in nextItem) {
      payload.highlighted = nextItem.highlighted === true;
    }

    if ("rating" in nextItem) {
      payload.rating = nextItem.rating ?? null;
    }

    setCuration((current) => applyCurationItem(current, id, nextItem));
    setArtworks((current) =>
      current.map((artwork) =>
        artwork.id === id ? applyArtworkCuration(artwork, nextItem) : artwork
      )
    );
    setSaveStatus("saving");

    try {
      const response = await fetch("/api/curation", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!response.ok) throw new Error("Failed to save curation");

      setSaveStatus("saved");
      setRefreshToken((current) => current + 1);
    } catch {
      setCuration((current) => applyCurationItem(current, id, previousItem ?? {}));
      setArtworks((current) =>
        current.map((artwork) =>
          artwork.id === id
            ? applyArtworkCuration(artwork, previousItem ?? {})
            : artwork
        )
      );
      setSaveStatus("error");
    }
  }

  async function copyRequest(key: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedRequest(key);
      window.setTimeout(() => setCopiedRequest(undefined), 1800);
    } catch {
      setCopiedRequest(`${key}-error`);
      window.setTimeout(() => setCopiedRequest(undefined), 1800);
    }
  }

  function resetToFirstPage() {
    setPage(DEFAULT_PAGE);
  }

  function renderCurationControls(artwork: Artwork, compact = false) {
    const item = curation[artwork.id] ?? {};

    if (readOnlyCuration) {
      return (
        <div className={styles.readOnlyCuration}>
          {item.highlighted ? <span>Highlighted</span> : null}
          <span>{item.rating ? `Rating ${item.rating}` : "Unrated"}</span>
        </div>
      );
    }

    return (
      <div
        className={
          compact
            ? `${styles.curationControls} ${styles.curationControlsCompact}`
            : styles.curationControls
        }
      >
        <label className={styles.inlineHighlightToggle}>
          <input
            type="checkbox"
            checked={item.highlighted ?? false}
            onChange={(event) =>
              saveItem(artwork.id, {
                ...item,
                highlighted: event.target.checked,
              })
            }
          />
          <span>Highlighted</span>
        </label>
        <div className={styles.ratingGroup} aria-label="Rating">
          {[1, 2, 3, 4, 5].map((rating) => (
            <button
              key={rating}
              type="button"
              className={
                item.rating === rating
                  ? `${styles.ratingButton} ${styles.ratingButtonActive}`
                  : styles.ratingButton
              }
              onClick={() =>
                saveItem(artwork.id, {
                  ...item,
                  rating:
                    item.rating === rating
                      ? undefined
                      : (rating as ArtworkCurationItem["rating"]),
                })
              }
              aria-pressed={item.rating === rating}
            >
              {rating}
            </button>
          ))}
        </div>
      </div>
    );
  }

  function renderActiveFilters() {
    const filters: Array<{ key: string; label: string; onClear: () => void }> = [];

    if (query.trim()) {
      filters.push({
        key: "query",
        label: `Search: ${query.trim()}`,
        onClear: () => {
          setQuery("");
          resetToFirstPage();
        },
      });
    }

    if (sourceFilter !== "all") {
      filters.push({
        key: "source",
        label: `Source: ${sourceFilter}`,
        onClear: () => {
          setSourceFilter("all");
          resetToFirstPage();
        },
      });
    }

    if (highlightFilter !== "all") {
      filters.push({
        key: "highlight",
        label:
          highlightFilter === "highlighted"
            ? "Highlighted"
            : "Not highlighted",
        onClear: () => {
          setHighlightFilter("all");
          resetToFirstPage();
        },
      });
    }

    if (ratingFilter !== "all") {
      filters.push({
        key: "rating",
        label:
          ratingFilter === "rated" || ratingFilter === "unrated"
            ? capitalize(ratingFilter)
            : `Rating ${ratingFilter}`,
        onClear: () => {
          setRatingFilter("all");
          resetToFirstPage();
        },
      });
    }

    if (filters.length === 0) return null;

    return (
      <div className={styles.activeFilters} aria-label="Active filters">
        {filters.map((filter) => (
          <button
            key={filter.key}
            type="button"
            className={styles.filterChip}
            onClick={filter.onClear}
          >
            {filter.label}
            <span aria-hidden="true">x</span>
          </button>
        ))}
      </div>
    );
  }

  return (
    <>
      <div className={styles.curationBar}>
        <span>{formatPageSummary(pageStart, pageEnd, total)}</span>
        <span>{catalogMeta.totalCatalogItems} total</span>
        <span>{stats.highlighted} highlighted</span>
        <span>{stats.rated} rated</span>
        {isLoading ? <span>Loading</span> : null}
        {readOnlyCuration ? <span>Read only</span> : null}
        {!readOnlyCuration ? (
          <span aria-live="polite">
            {saveStatus === "saving" ? "Saving" : null}
            {saveStatus === "saved" ? "Saved" : null}
            {saveStatus === "error" ? "Save failed" : null}
          </span>
        ) : null}
      </div>

      <div className={styles.filterPanel}>
        <label className={styles.searchField}>
          <span>Search</span>
          <span className={styles.searchInputWrap}>
            <input
              type="search"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                resetToFirstPage();
              }}
              placeholder="Title, artist, tag, collection, license"
            />
            {query ? (
              <button
                type="button"
                className={styles.clearSearchButton}
                onClick={() => {
                  setQuery("");
                  resetToFirstPage();
                }}
                aria-label="Clear search"
              >
                x
              </button>
            ) : null}
          </span>
        </label>

        <label className={styles.filterField}>
          <span>Source</span>
          <select
            value={sourceFilter}
            onChange={(event) => {
              setSourceFilter(event.target.value as SourceFilter);
              resetToFirstPage();
            }}
          >
            <option value="all">All</option>
            {sourceOptions.map((source) => (
              <option key={source} value={source}>
                {source}
              </option>
            ))}
          </select>
        </label>

        <label className={styles.filterField}>
          <span>Highlight</span>
          <select
            value={highlightFilter}
            onChange={(event) => {
              setHighlightFilter(event.target.value as HighlightFilter);
              resetToFirstPage();
            }}
          >
            <option value="all">All</option>
            <option value="highlighted">Highlighted</option>
            <option value="not-highlighted">Not highlighted</option>
          </select>
        </label>

        <label className={styles.filterField}>
          <span>Rating</span>
          <select
            value={ratingFilter}
            onChange={(event) => {
              setRatingFilter(event.target.value as RatingFilter);
              resetToFirstPage();
            }}
          >
            <option value="all">All</option>
            <option value="rated">Rated</option>
            <option value="unrated">Unrated</option>
            {[1, 2, 3, 4, 5].map((rating) => (
              <option key={rating} value={rating}>
                {rating}
              </option>
            ))}
          </select>
        </label>

        <label className={styles.filterField}>
          <span>Page size</span>
          <select
            value={pageSize}
            onChange={(event) => {
              setPageSize(Number(event.target.value));
              resetToFirstPage();
            }}
          >
            {PAGE_SIZE_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>

        <button
          type="button"
          className={styles.resetFiltersButton}
          disabled={!hasActiveFilters}
          onClick={() => {
            setQuery("");
            setSourceFilter("all");
            setHighlightFilter("all");
            setRatingFilter("all");
            setPage(DEFAULT_PAGE);
            setPageSize(DEFAULT_PAGE_SIZE);
          }}
        >
          Reset
        </button>
      </div>

      {renderActiveFilters()}

      <section className={styles.apiPanel} aria-label="API requests">
        <div className={styles.apiPanelHeader}>
          <h2>API requests</h2>
          <span>{pageSize} limit with {pageStart} offset</span>
        </div>
        <ApiRequestRow
          label="List"
          value={listApiPath}
          copyLabel={copiedRequest === "list" ? "Copied" : "Copy"}
          onCopy={() => copyRequest("list", listApiPath)}
        />
        <ApiRequestRow
          label="cURL"
          value={listCurl}
          copyLabel={copiedRequest === "curl" ? "Copied" : "Copy"}
          onCopy={() => copyRequest("curl", listCurl)}
        />
      </section>

      {loadError ? (
        <p className={styles.empty}>{loadError}</p>
      ) : !isLoading && total === 0 ? (
        <p className={styles.empty}>No artworks match the current filters.</p>
      ) : (
        <>
          <Pagination
            currentPage={currentPage}
            pageCount={pageCount}
            onPageChange={setPage}
          />

          <ul className={styles.grid}>
            {pageArtworks.map((artwork) => {
              const { displayUrl, downloadUrl, isSvg } = getArtworkImageUrls(artwork);
              const item = curation[artwork.id] ?? {};
              const cardClassName = item.highlighted
                ? `${styles.card} ${styles.cardHighlighted}`
                : styles.card;

              return (
                <li key={artwork.id} className={cardClassName}>
                  {readOnlyCuration ? (
                    item.highlighted ? (
                      <span
                        className={styles.highlightIndicator}
                        aria-label="Highlighted"
                      />
                    ) : null
                  ) : (
                    <label className={styles.highlightToggle}>
                      <input
                        type="checkbox"
                        className={styles.highlightCheckbox}
                        checked={item.highlighted ?? false}
                        onChange={(event) =>
                          saveItem(artwork.id, {
                            ...item,
                            highlighted: event.target.checked,
                          })
                        }
                        aria-label={`Highlight ${artwork.title}`}
                      />
                      <span
                        className={styles.highlightControl}
                        aria-hidden="true"
                      />
                    </label>
                  )}

                  <button
                    type="button"
                    className={styles.previewButton}
                    onClick={() => setSelectedArtworkId(artwork.id)}
                    aria-label={`Preview ${artwork.title}`}
                  >
                    {displayUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={displayUrl}
                        alt={artwork.title}
                        className={`${styles.thumb} ${
                          isSvg ? styles.thumbContain : ""
                        }`}
                        loading="lazy"
                      />
                    ) : (
                      <span className={styles.missingThumb}>No image</span>
                    )}
                  </button>

                  <div className={styles.meta}>
                    <div className={styles.titleRow}>
                      <button
                        type="button"
                        className={styles.titleButton}
                        onClick={() => setSelectedArtworkId(artwork.id)}
                      >
                        {artwork.title}
                      </button>
                      <span className={styles.badge}>{artwork.source}</span>
                    </div>
                    <div className={styles.subtitle}>
                      {compactCredit(artwork)}
                    </div>
                    {renderCurationControls(artwork, true)}
                    <div className={styles.links}>
                      <a
                        href={downloadUrl}
                        download={downloadFilename(artwork, downloadUrl)}
                      >
                        Download
                      </a>
                      <a
                        href={artwork.sourceUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Source
                      </a>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>

          <Pagination
            currentPage={currentPage}
            pageCount={pageCount}
            onPageChange={setPage}
          />
        </>
      )}

      {selectedArtwork ? (
        <ArtworkPreview
          artwork={selectedArtwork}
          canGoNext={selectedIndex < pageArtworks.length - 1}
          canGoPrevious={selectedIndex > 0}
          copiedRequest={copiedRequest}
          readOnlyCuration={readOnlyCuration}
          renderCurationControls={renderCurationControls}
          onClose={() => setSelectedArtworkId(undefined)}
          onCopy={copyRequest}
          onNext={() => {
            if (selectedIndex < pageArtworks.length - 1) {
              setSelectedArtworkId(pageArtworks[selectedIndex + 1].id);
            }
          }}
          onPrevious={() => {
            if (selectedIndex > 0) {
              setSelectedArtworkId(pageArtworks[selectedIndex - 1].id);
            }
          }}
        />
      ) : null}
    </>
  );
}

function Pagination({
  currentPage,
  pageCount,
  onPageChange,
}: {
  currentPage: number;
  pageCount: number;
  onPageChange: (page: number) => void;
}) {
  if (pageCount <= 1) return null;

  const pages = getVisiblePages(currentPage, pageCount);

  return (
    <nav className={styles.pagination} aria-label="Artwork pages">
      <button
        type="button"
        onClick={() => onPageChange(Math.max(1, currentPage - 1))}
        disabled={currentPage === 1}
      >
        Previous
      </button>
      {pages.map((pageNumber) => (
        <button
          key={pageNumber}
          type="button"
          className={
            pageNumber === currentPage ? styles.paginationButtonActive : ""
          }
          onClick={() => onPageChange(pageNumber)}
          aria-current={pageNumber === currentPage ? "page" : undefined}
        >
          {pageNumber}
        </button>
      ))}
      <button
        type="button"
        onClick={() => onPageChange(Math.min(pageCount, currentPage + 1))}
        disabled={currentPage === pageCount}
      >
        Next
      </button>
    </nav>
  );
}

function ApiRequestRow({
  label,
  value,
  copyLabel,
  onCopy,
}: {
  label: string;
  value: string;
  copyLabel: string;
  onCopy: () => void;
}) {
  return (
    <div className={styles.apiRequestRow}>
      <span>{label}</span>
      <code>{value}</code>
      <button type="button" onClick={onCopy}>
        {copyLabel}
      </button>
    </div>
  );
}

function ArtworkPreview({
  artwork,
  canGoNext,
  canGoPrevious,
  copiedRequest,
  readOnlyCuration,
  renderCurationControls,
  onClose,
  onCopy,
  onNext,
  onPrevious,
}: {
  artwork: Artwork;
  canGoNext: boolean;
  canGoPrevious: boolean;
  copiedRequest?: string;
  readOnlyCuration: boolean;
  renderCurationControls: (artwork: Artwork) => ReactNode;
  onClose: () => void;
  onCopy: (key: string, value: string) => void;
  onNext: () => void;
  onPrevious: () => void;
}) {
  const { displayUrl, downloadUrl, isSvg } = getArtworkImageUrls(artwork);
  const detailApiPath = `/api/artworks/${encodeURIComponent(artwork.id)}`;
  const detailCurl = toCurlRequest(detailApiPath);

  return (
    <div
      className={styles.previewOverlay}
      role="dialog"
      aria-modal="true"
      aria-labelledby="artwork-preview-title"
    >
      <button
        type="button"
        className={styles.previewCloseButton}
        onClick={onClose}
        aria-label="Close preview"
        title="Close preview"
      >
        <span aria-hidden="true" />
      </button>
      <div className={styles.previewMedia}>
        <button
          type="button"
          className={`${styles.previewNavButton} ${styles.previewNavPrevious}`}
          onClick={onPrevious}
          disabled={!canGoPrevious}
          aria-label="Previous artwork"
        >
          Previous
        </button>
        {displayUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={displayUrl}
            alt={artwork.title}
            className={isSvg ? styles.previewImageContain : styles.previewImage}
          />
        ) : (
          <div className={styles.previewMissingImage}>No image</div>
        )}
        <button
          type="button"
          className={`${styles.previewNavButton} ${styles.previewNavNext}`}
          onClick={onNext}
          disabled={!canGoNext}
          aria-label="Next artwork"
        >
          Next
        </button>
      </div>

      <aside className={styles.previewDetails}>
        <div className={styles.previewHeader}>
          <span className={styles.badge}>{artwork.source}</span>
          {readOnlyCuration ? <span className={styles.badge}>Read only</span> : null}
        </div>
        <h2 id="artwork-preview-title">{artwork.title}</h2>
        <p className={styles.previewCredit}>{compactCredit(artwork)}</p>

        {renderCurationControls(artwork)}

        <div className={styles.previewActions}>
          <a href={downloadUrl} download={downloadFilename(artwork, downloadUrl)}>
            Download
          </a>
          <a href={artwork.sourceUrl} target="_blank" rel="noreferrer">
            Source
          </a>
          {artwork.licenseUrl ? (
            <a href={artwork.licenseUrl} target="_blank" rel="noreferrer">
              License
            </a>
          ) : null}
        </div>

        {artwork.description ? (
          <p className={styles.previewDescription}>{artwork.description}</p>
        ) : null}

        <dl className={styles.detailList}>
          <DetailRow label="ID" value={artwork.id} />
          <DetailRow label="Source ID" value={artwork.sourceId} />
          <DetailRow label="License" value={artwork.license} />
          <DetailRow label="Rights" value={artwork.rights} />
          <DetailRow
            label="Dimensions"
            value={
              artwork.image.width && artwork.image.height
                ? `${artwork.image.width} x ${artwork.image.height}`
                : undefined
            }
          />
          <DetailRow label="Collection" value={artwork.collection?.name} />
          <DetailRow label="Author" value={artwork.author?.name} />
          <DetailRow label="Search" value={artwork.search?.query} />
          <DetailRow label="Downloaded" value={formatDate(artwork.search?.downloadedAt)} />
        </dl>

        {artwork.tags?.length ? (
          <div className={styles.tagList} aria-label="Tags">
            {artwork.tags.map((tag) => (
              <span key={tag}>{tag}</span>
            ))}
          </div>
        ) : null}

        <section className={styles.previewApiPanel} aria-label="Artwork API requests">
          <h3>API requests</h3>
          <ApiRequestRow
            label="Detail"
            value={detailApiPath}
            copyLabel={copiedRequest === "detail" ? "Copied" : "Copy"}
            onCopy={() => onCopy("detail", detailApiPath)}
          />
          <ApiRequestRow
            label="cURL"
            value={detailCurl}
            copyLabel={copiedRequest === "detail-curl" ? "Copied" : "Copy"}
            onCopy={() => onCopy("detail-curl", detailCurl)}
          />
        </section>
      </aside>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value?: string }) {
  if (!value) return null;

  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
}

function applyCurationItem(
  curation: ArtworkCuration,
  id: string,
  item: ArtworkCurationItem
): ArtworkCuration {
  const next = { ...curation };
  const nextItem = normalizeClientItem(item);

  if (nextItem.highlighted || nextItem.rating) {
    next[id] = nextItem;
  } else {
    delete next[id];
  }

  return next;
}

function applyArtworkCuration(
  artwork: ArtworkApiItem,
  item: ArtworkCurationItem
): ArtworkApiItem {
  const nextItem = normalizeClientItem(item);

  return {
    ...artwork,
    selected: nextItem.highlighted === true,
    highlighted: nextItem.highlighted === true,
    rating: nextItem.rating,
  };
}

function pageCurationFromItems(items: ArtworkApiItem[]): ArtworkCuration {
  return Object.fromEntries(
    items.flatMap((item) => {
      const curationItem = normalizeClientItem({
        highlighted: item.highlighted,
        rating: item.rating,
      });

      return curationItem.highlighted || curationItem.rating
        ? [[item.id, curationItem] as const]
        : [];
    })
  );
}

function normalizeClientItem(item: ArtworkCurationItem): ArtworkCurationItem {
  return {
    ...(item.highlighted ? { highlighted: true } : {}),
    ...(item.rating ? { rating: item.rating } : {}),
  };
}

function readUrlFilters(): UrlFilters {
  if (typeof window === "undefined") {
    return defaultUrlFilters();
  }

  const params = new URLSearchParams(window.location.search);
  const sourceParam = params.get("source");
  const highlightedParam = params.get("highlighted");
  const highlightParam = params.get("highlight");
  const ratingParam = params.get("rating");

  return {
    query: params.get("q") ?? "",
    sourceFilter:
      sourceParam && ARTWORK_SOURCES.includes(sourceParam as Artwork["source"])
        ? (sourceParam as SourceFilter)
        : "all",
    highlightFilter: parseHighlightFilter(highlightedParam, highlightParam),
    ratingFilter: parseRatingFilter(ratingParam),
    page: parsePage(params.get("page")),
    pageSize: parsePageSize(params.get("pageSize") ?? params.get("limit")),
  };
}

function defaultUrlFilters(): UrlFilters {
  return {
    query: "",
    sourceFilter: "all",
    highlightFilter: "all",
    ratingFilter: "all",
    page: DEFAULT_PAGE,
    pageSize: DEFAULT_PAGE_SIZE,
  };
}

function writeUrlFilters(filters: UrlFilters) {
  if (typeof window === "undefined") return;

  const url = new URL(window.location.href);
  setOrDeleteParam(url.searchParams, "q", filters.query.trim());
  setOrDeleteParam(
    url.searchParams,
    "source",
    filters.sourceFilter === "all" ? "" : filters.sourceFilter
  );
  setOrDeleteParam(
    url.searchParams,
    "highlighted",
    filters.highlightFilter === "all"
      ? ""
      : String(filters.highlightFilter === "highlighted")
  );
  setOrDeleteParam(
    url.searchParams,
    "rating",
    filters.ratingFilter === "all" ? "" : filters.ratingFilter
  );
  setOrDeleteParam(
    url.searchParams,
    "page",
    filters.page === DEFAULT_PAGE ? "" : String(filters.page)
  );
  setOrDeleteParam(
    url.searchParams,
    "pageSize",
    filters.pageSize === DEFAULT_PAGE_SIZE ? "" : String(filters.pageSize)
  );
  url.searchParams.delete("limit");

  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

function setOrDeleteParam(
  params: URLSearchParams,
  name: string,
  value: string
) {
  if (value) {
    params.set(name, value);
  } else {
    params.delete(name);
  }
}

function parseHighlightFilter(
  highlightedParam: string | null,
  highlightParam: string | null
): HighlightFilter {
  if (highlightedParam === "true" || highlightedParam === "1") {
    return "highlighted";
  }
  if (highlightedParam === "false" || highlightedParam === "0") {
    return "not-highlighted";
  }
  if (highlightParam === "highlighted" || highlightParam === "not-highlighted") {
    return highlightParam;
  }
  return "all";
}

function parseRatingFilter(value: string | null): RatingFilter {
  if (
    value === "rated" ||
    value === "unrated" ||
    value === "1" ||
    value === "2" ||
    value === "3" ||
    value === "4" ||
    value === "5"
  ) {
    return value;
  }
  return "all";
}

function parsePage(value: string | null) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_PAGE;
  return Math.trunc(parsed);
}

function parsePageSize(value: string | null) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_PAGE_SIZE;
  return PAGE_SIZE_OPTIONS.includes(parsed)
    ? parsed
    : PAGE_SIZE_OPTIONS.reduce((closest, option) =>
        Math.abs(option - parsed) < Math.abs(closest - parsed) ? option : closest
      );
}

function downloadFilename(artwork: Artwork, url: string) {
  const extension = url.split("?")[0].split(".").pop() || "jpg";
  const slug = artwork.title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);

  return `${slug || artwork.sourceId}.${extension}`;
}

function getArtworkImageUrls(artwork: Artwork) {
  const displayUrl =
    artwork.image.localResizedPaths?.["1024"] ??
    artwork.image.localResizedPaths?.["512"] ??
    artwork.image.localOriginalPath ??
    artwork.image.originalUrl;
  const downloadUrl =
    artwork.image.localOriginalPath ??
    artwork.image.localResizedPaths?.["1024"] ??
    artwork.image.localResizedPaths?.["512"] ??
    artwork.image.originalUrl;
  const isSvg =
    typeof displayUrl === "string" &&
    displayUrl.toLowerCase().split("?")[0].endsWith(".svg");

  return { displayUrl, downloadUrl, isSvg };
}

function buildArtworkListApiPath({
  query,
  sourceFilter,
  highlightFilter,
  ratingFilter,
  pageSize,
  offset,
}: {
  query: string;
  sourceFilter: SourceFilter;
  highlightFilter: HighlightFilter;
  ratingFilter: RatingFilter;
  pageSize: number;
  offset: number;
}) {
  const params = new URLSearchParams();
  setOrDeleteParam(params, "q", query.trim());
  setOrDeleteParam(params, "source", sourceFilter === "all" ? "" : sourceFilter);
  setOrDeleteParam(
    params,
    "highlighted",
    highlightFilter === "all" ? "" : String(highlightFilter === "highlighted")
  );
  setOrDeleteParam(params, "rating", ratingFilter === "all" ? "" : ratingFilter);
  params.set("limit", String(pageSize));
  params.set("offset", String(offset));

  return `/api/artworks?${params.toString()}`;
}

function toCurlRequest(path: string) {
  return `curl -H "Authorization: Bearer $ART_API_KEY" "$APP_ORIGIN${path}"`;
}

function formatPageSummary(start: number, end: number, total: number) {
  if (total === 0) return "0 matches";
  return `${start + 1}-${end} of ${total} matches`;
}

function getVisiblePages(currentPage: number, pageCount: number) {
  const start = Math.max(1, Math.min(currentPage - 2, pageCount - 4));
  const end = Math.min(pageCount, start + 4);
  const pages = [];

  for (let pageNumber = start; pageNumber <= end; pageNumber += 1) {
    pages.push(pageNumber);
  }

  return pages;
}

function compactCredit(artwork: Artwork) {
  const parts = [artwork.artist, artwork.date].filter(Boolean);
  return parts.length > 0 ? parts.join(" / ") : "Unknown artist";
}

function capitalize(value: string) {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function formatDate(value?: string) {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}
