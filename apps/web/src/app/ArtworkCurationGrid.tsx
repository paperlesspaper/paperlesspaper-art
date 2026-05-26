"use client";

import { useMemo, useState } from "react";
import type { Artwork } from "@/lib/artworks";
import type {
  ArtworkCuration,
  ArtworkCurationItem,
} from "@/lib/artwork-curation";
import styles from "./page.module.css";

type Props = {
  artworks: Artwork[];
  initialCuration: ArtworkCuration;
};

type SaveStatus = "idle" | "saving" | "saved" | "error";
type SourceFilter = "all" | Artwork["source"];
type HighlightFilter = "all" | "highlighted" | "not-highlighted";
type RatingFilter = "all" | "rated" | "unrated" | "1" | "2" | "3" | "4" | "5";

export function ArtworkCurationGrid({ artworks, initialCuration }: Props) {
  const [curation, setCuration] = useState<ArtworkCuration>(initialCuration);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [query, setQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [highlightFilter, setHighlightFilter] =
    useState<HighlightFilter>("all");
  const [ratingFilter, setRatingFilter] = useState<RatingFilter>("all");

  const stats = useMemo(() => {
    return Object.values(curation).reduce(
      (counts, item) => {
        if (item.highlighted) counts.highlighted += 1;
        if (item.rating) counts.rated += 1;
        return counts;
      },
      { highlighted: 0, rated: 0 }
    );
  }, [curation]);

  const sourceOptions = useMemo(() => {
    return Array.from(new Set(artworks.map((artwork) => artwork.source))).sort();
  }, [artworks]);

  const filteredArtworks = useMemo(() => {
    const terms = normalizeSearch(query).split(" ").filter(Boolean);

    return artworks.filter((artwork) => {
      const item = curation[artwork.id] ?? {};

      if (sourceFilter !== "all" && artwork.source !== sourceFilter) {
        return false;
      }

      if (highlightFilter === "highlighted" && !item.highlighted) {
        return false;
      }

      if (highlightFilter === "not-highlighted" && item.highlighted) {
        return false;
      }

      if (ratingFilter === "rated" && !item.rating) {
        return false;
      }

      if (ratingFilter === "unrated" && item.rating) {
        return false;
      }

      if (
        ratingFilter !== "all" &&
        ratingFilter !== "rated" &&
        ratingFilter !== "unrated" &&
        item.rating !== Number(ratingFilter)
      ) {
        return false;
      }

      if (terms.length === 0) return true;

      const searchable = normalizeSearch(
        [
          artwork.title,
          artwork.artist,
          artwork.date,
          artwork.source,
          artwork.sourceId,
          artwork.license,
          artwork.collection?.name,
          artwork.author?.name,
          ...(artwork.tags ?? []),
        ].join(" ")
      );

      return terms.every((term) => searchable.includes(term));
    });
  }, [artworks, curation, highlightFilter, query, ratingFilter, sourceFilter]);

  const hasActiveFilters =
    query.length > 0 ||
    sourceFilter !== "all" ||
    highlightFilter !== "all" ||
    ratingFilter !== "all";

  async function saveItem(id: string, nextItem: ArtworkCurationItem) {
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
    setSaveStatus("saving");

    try {
      const response = await fetch("/api/curation", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!response.ok) throw new Error("Failed to save curation");

      setSaveStatus("saved");
    } catch {
      setCuration((current) => applyCurationItem(current, id, previousItem ?? {}));
      setSaveStatus("error");
    }
  }

  return (
    <>
      <div className={styles.curationBar}>
        <span>
          {filteredArtworks.length} / {artworks.length} shown
        </span>
        <span>{stats.highlighted} highlighted</span>
        <span>{stats.rated} rated</span>
        <span aria-live="polite">
          {saveStatus === "saving" ? "Saving" : null}
          {saveStatus === "saved" ? "Saved" : null}
          {saveStatus === "error" ? "Save failed" : null}
        </span>
      </div>

      <div className={styles.filterPanel}>
        <label className={styles.searchField}>
          <span>Search</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Title, artist, tag"
          />
        </label>

        <label className={styles.filterField}>
          <span>Source</span>
          <select
            value={sourceFilter}
            onChange={(event) =>
              setSourceFilter(event.target.value as SourceFilter)
            }
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
            onChange={(event) =>
              setHighlightFilter(event.target.value as HighlightFilter)
            }
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
            onChange={(event) =>
              setRatingFilter(event.target.value as RatingFilter)
            }
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

        <button
          type="button"
          className={styles.resetFiltersButton}
          disabled={!hasActiveFilters}
          onClick={() => {
            setQuery("");
            setSourceFilter("all");
            setHighlightFilter("all");
            setRatingFilter("all");
          }}
        >
          Reset
        </button>
      </div>

      {filteredArtworks.length === 0 ? (
        <p className={styles.empty}>No artworks match the current filters.</p>
      ) : (
        <ul className={styles.grid}>
          {filteredArtworks.map((artwork) => {
          const preferred =
            artwork.image.localResizedPaths?.["512"] ??
            artwork.image.localResizedPaths?.["1024"] ??
            artwork.image.localOriginalPath;
          const isSvg =
            typeof preferred === "string" &&
            preferred.toLowerCase().split("?")[0].endsWith(".svg");
          const item = curation[artwork.id] ?? {};
          const cardClassName = item.highlighted
            ? `${styles.card} ${styles.cardHighlighted}`
            : styles.card;

          return (
            <li key={artwork.id} className={cardClassName}>
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
                <span className={styles.highlightControl} aria-hidden="true" />
              </label>

              {preferred ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={preferred}
                  alt={artwork.title}
                  className={`${styles.thumb} ${
                    isSvg ? styles.thumbContain : ""
                  }`}
                  loading="lazy"
                />
              ) : null}

              <div className={styles.meta}>
                <div className={styles.titleRow}>
                  <strong className={styles.title}>{artwork.title}</strong>
                  <span className={styles.badge}>{artwork.source}</span>
                </div>
                <div className={styles.subtitle}>
                  {artwork.artist ? <span>{artwork.artist}</span> : null}
                  {artwork.artist && artwork.date ? <span> · </span> : null}
                  {artwork.date ? <span>{artwork.date}</span> : null}
                </div>
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
                <div className={styles.links}>
                  <a href={artwork.sourceUrl} target="_blank" rel="noreferrer">
                    Source
                  </a>
                </div>
              </div>
            </li>
          );
          })}
        </ul>
      )}
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

function normalizeClientItem(item: ArtworkCurationItem): ArtworkCurationItem {
  return {
    ...(item.highlighted ? { highlighted: true } : {}),
    ...(item.rating ? { rating: item.rating } : {}),
  };
}

function normalizeSearch(value: string) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
