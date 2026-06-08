"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  acepPalette,
  aitjcizeSpectra6Palette,
  defaultPalette,
  ditherImage,
  gameboyPalette,
  getProcessingPreset,
  getProcessingPresetOptions,
  replaceColors,
  spectra6OriginalPalette,
  suggestCanvasImageAdjustmentOptions,
  suggestCanvasProcessingOptions,
  suggestLayeredCanvasProcessingOptions,
} from "epdoptimize";
import type {
  AutoProcessingIntent,
  ColorMatchingMode,
  DitherImageOptions,
  DitherProcessingEngine,
  DitheringType,
  PaletteColorEntry,
  ProcessingPresetName,
} from "epdoptimize";
import type {
  Artwork,
  ArtworkApiItem,
  ArtworkCatalogMeta,
  ArtworkSort,
} from "@/lib/artworks";
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
type EpdPreviewMode = "original" | "dithered" | "device";
type EpdPaletteKey = "spectra6" | "spectra6-original" | "acep" | "bw" | "gameboy";
type EpdCanvasPreset = "1600x1200" | "800x480";
type EpdCanvasOrientation = "landscape" | "portrait";
type EpdImageFit = "cover" | "contain";
type EpdPresetKey = "auto" | "autoDitherManual" | "manual" | ProcessingPresetName;
type EpdAutoFlow = "layered" | "previous";
type EpdDitherType = Extract<
  DitheringType,
  | "errorDiffusion"
  | "ordered"
  | "random"
  | "quantizationOnly"
  | "hueMix"
  | "ditherItErrorDiffusion"
  | "ditherItOrdered"
  | "ditherItBlueNoise"
  | "ditherItSimple2D"
  | "ditherItRiemersma"
>;
type EpdRandomDitherType = "blackAndWhite" | "rgb";
type EpdControls = {
  paletteKey: EpdPaletteKey;
  canvasPreset: EpdCanvasPreset;
  canvasOrientation: EpdCanvasOrientation;
  imageFit: EpdImageFit;
  processingPreset: EpdPresetKey;
  autoFlow: EpdAutoFlow;
  intent: AutoProcessingIntent;
  ditheringType: EpdDitherType;
  errorDiffusionMatrix: string;
  orderedMatrixWidth: number;
  orderedMatrixHeight: number;
  randomDitheringType: EpdRandomDitherType;
  colorMatching: ColorMatchingMode;
  processingEngine: DitherProcessingEngine;
  serpentine: boolean;
  exposure: number;
  saturation: number;
  contrast: number;
  clarity: number;
  scurveStrength: number;
  shadowBoost: number;
  highlightCompress: number;
  dynamicRangeMode: "off" | "display" | "auto";
  dynamicRangeStrength: number;
  lowPercentile: number;
  highPercentile: number;
  paperNormalization: boolean;
  edgePreservation: boolean;
  edgePreservationStrength: number;
  edgeAntialiasing: boolean;
  edgeAntialiasingStrength: number;
};
type UrlFilters = {
  query: string;
  sourceFilter: SourceFilter;
  highlightFilter: HighlightFilter;
  ratingFilter: RatingFilter;
  sort: ArtworkSort;
  page: number;
  pageSize: number;
};

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 60;
const DEFAULT_SORT: ArtworkSort = "curated";
const PAGE_SIZE_OPTIONS = [40, 60, 100, 160];
const SORT_OPTIONS: Array<{ value: ArtworkSort; label: string }> = [
  { value: "curated", label: "Curated" },
  { value: "relevance", label: "Relevance" },
  { value: "date-desc", label: "Artwork date, newest" },
  { value: "date-asc", label: "Artwork date, oldest" },
  { value: "downloaded-desc", label: "Downloaded, newest" },
  { value: "downloaded-asc", label: "Downloaded, oldest" },
  { value: "title-asc", label: "Title A-Z" },
  { value: "title-desc", label: "Title Z-A" },
  { value: "rating-desc", label: "Rating, high first" },
  { value: "rating-asc", label: "Rating, low first" },
];
const ARTWORK_SOURCES: Array<Artwork["source"]> = [
  "artic",
  "met",
  "svgrepo",
  "wikimedia",
];
const EPD_PALETTE_OPTIONS: Array<{
  value: EpdPaletteKey;
  label: string;
  palette: PaletteColorEntry[];
}> = [
  {
    value: "spectra6",
    label: "Spectra 6",
    palette: aitjcizeSpectra6Palette,
  },
  {
    value: "spectra6-original",
    label: "Spectra 6 native",
    palette: spectra6OriginalPalette,
  },
  { value: "acep", label: "Gallery / ACeP", palette: acepPalette },
  { value: "bw", label: "Black and white", palette: defaultPalette },
  { value: "gameboy", label: "Game Boy", palette: gameboyPalette },
];
const EPD_CANVAS_OPTIONS: Array<{ value: EpdCanvasPreset; label: string }> = [
  { value: "1600x1200", label: "1600 x 1200" },
  { value: "800x480", label: "800 x 480" },
];
const EPD_ORIENTATION_OPTIONS: Array<{
  value: EpdCanvasOrientation;
  label: string;
}> = [
  { value: "landscape", label: "Landscape" },
  { value: "portrait", label: "Portrait" },
];
const EPD_IMAGE_FIT_OPTIONS: Array<{ value: EpdImageFit; label: string }> = [
  { value: "cover", label: "Cover" },
  { value: "contain", label: "Fit inside" },
];
const EPD_PRESET_OPTIONS: Array<{
  value: EpdPresetKey;
  label: string;
  title?: string;
}> = [
  { value: "auto", label: "Auto" },
  {
    value: "autoDitherManual",
    label: "Auto canvas dither, manual image",
  },
  { value: "manual", label: "Manual" },
  ...getProcessingPresetOptions().map((preset) => ({
    value: preset.value,
    label: preset.title,
    title: preset.description,
  })),
];
const EPD_INTENT_OPTIONS: Array<{ value: AutoProcessingIntent; label: string }> =
  [
    { value: "natural", label: "Natural" },
    { value: "vivid", label: "Vivid" },
    { value: "readable", label: "Readable" },
    { value: "faithful", label: "Faithful" },
    { value: "lowNoise", label: "Low noise" },
  ];
const EPD_AUTO_FLOW_OPTIONS: Array<{ value: EpdAutoFlow; label: string }> = [
  { value: "layered", label: "Layered auto" },
  { value: "previous", label: "Previous auto" },
];
const EPD_DITHER_OPTIONS: Array<{ value: EpdDitherType; label: string }> = [
  { value: "errorDiffusion", label: "Error diffusion" },
  { value: "ordered", label: "Ordered" },
  { value: "random", label: "Random" },
  { value: "quantizationOnly", label: "Quantization only" },
  { value: "hueMix", label: "Hue mix experimental" },
  { value: "ditherItErrorDiffusion", label: "DITHER IT: Error diffusion" },
  { value: "ditherItOrdered", label: "DITHER IT: Bayer" },
  { value: "ditherItBlueNoise", label: "DITHER IT: Blue noise" },
  { value: "ditherItSimple2D", label: "DITHER IT: Simple 2D" },
  { value: "ditherItRiemersma", label: "DITHER IT: Riemersma" },
];
const EPD_DIFFUSION_OPTIONS = [
  { value: "floydSteinberg", label: "Floyd-Steinberg" },
  { value: "atkinson", label: "Atkinson" },
  { value: "falseFloydSteinberg", label: "False Floyd-Steinberg" },
  { value: "jarvis", label: "Jarvis" },
  { value: "jarvisJudiceNinke", label: "Jarvis-Judice-Ninke" },
  { value: "stucki", label: "Stucki" },
  { value: "burkes", label: "Burkes" },
  { value: "sierra3", label: "Sierra 3" },
  { value: "sierra2", label: "Sierra 2" },
  { value: "sierra2-4a", label: "Sierra Lite" },
  { value: "fan", label: "Fan" },
  { value: "shiauFan", label: "Shiau-Fan" },
  { value: "shiauFan2", label: "Shiau-Fan 2" },
];
const EPD_COLOR_MATCHING_OPTIONS: Array<{
  value: ColorMatchingMode;
  label: string;
}> = [
  { value: "rgb", label: "RGB" },
  { value: "lab", label: "LAB" },
  { value: "chroma", label: "Chroma experimental" },
];
const EPD_PROCESSING_ENGINE_OPTIONS: Array<{
  value: DitherProcessingEngine;
  label: string;
}> = [
  { value: "auto", label: "Auto" },
  { value: "js", label: "JavaScript" },
  { value: "wasm", label: "WASM" },
];
const EPD_RANDOM_DITHER_OPTIONS: Array<{
  value: EpdRandomDitherType;
  label: string;
}> = [
  { value: "blackAndWhite", label: "Black and white" },
  { value: "rgb", label: "RGB" },
];
const DEFAULT_EPD_CONTROLS: EpdControls = {
  paletteKey: "spectra6",
  canvasPreset: "1600x1200",
  canvasOrientation: "landscape",
  imageFit: "cover",
  processingPreset: "auto",
  autoFlow: "layered",
  intent: "natural",
  ditheringType: "errorDiffusion",
  errorDiffusionMatrix: "floydSteinberg",
  orderedMatrixWidth: 4,
  orderedMatrixHeight: 4,
  randomDitheringType: "blackAndWhite",
  colorMatching: "rgb",
  processingEngine: "auto",
  serpentine: false,
  exposure: 0,
  saturation: 0,
  contrast: 0,
  clarity: 0,
  scurveStrength: 0,
  shadowBoost: 0,
  highlightCompress: 0,
  dynamicRangeMode: "off",
  dynamicRangeStrength: 1,
  lowPercentile: 0.01,
  highPercentile: 0.99,
  paperNormalization: false,
  edgePreservation: false,
  edgePreservationStrength: 0.65,
  edgeAntialiasing: false,
  edgeAntialiasingStrength: 0.75,
};

function createDefaultEpdControls(artwork: Artwork): EpdControls {
  return {
    ...DEFAULT_EPD_CONTROLS,
    canvasOrientation: getBestEpdCanvasOrientation(artwork),
  };
}

function getBestEpdCanvasOrientation(artwork: Artwork): EpdCanvasOrientation {
  const width = artwork.image.width ?? 0;
  const height = artwork.image.height ?? 0;

  return height > width ? "portrait" : "landscape";
}

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
  const [savingArtworkIds, setSavingArtworkIds] = useState<Set<string>>(
    () => new Set()
  );
  const [query, setQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [highlightFilter, setHighlightFilter] =
    useState<HighlightFilter>("all");
  const [ratingFilter, setRatingFilter] = useState<RatingFilter>("all");
  const [sort, setSort] = useState<ArtworkSort>(DEFAULT_SORT);
  const [page, setPage] = useState(DEFAULT_PAGE);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [selectedArtworkId, setSelectedArtworkId] = useState<string>();
  const [copiedRequest, setCopiedRequest] = useState<string>();
  const [hasLoadedUrlFilters, setHasLoadedUrlFilters] = useState(false);
  const saveStatusTimerRef = useRef<number | undefined>(undefined);

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
        sort,
        pageSize,
        offset: pageStart,
      }),
    [
      highlightFilter,
      pageSize,
      pageStart,
      query,
      ratingFilter,
      sort,
      sourceFilter,
    ]
  );
  const listCurl = useMemo(() => toCurlRequest(listApiPath), [listApiPath]);

  const hasActiveFilters =
    query.length > 0 ||
    sourceFilter !== "all" ||
    highlightFilter !== "all" ||
    ratingFilter !== "all" ||
    sort !== DEFAULT_SORT ||
    currentPage !== DEFAULT_PAGE ||
    pageSize !== DEFAULT_PAGE_SIZE;

  useEffect(() => {
    const filters = readUrlFilters();
    setQuery(filters.query);
    setSourceFilter(filters.sourceFilter);
    setHighlightFilter(filters.highlightFilter);
    setRatingFilter(filters.ratingFilter);
    setSort(filters.sort);
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
          cache: "no-store",
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
  }, [hasLoadedUrlFilters, listApiPath]);

  useEffect(() => {
    if (!hasLoadedUrlFilters) return;

    writeUrlFilters({
      query,
      sourceFilter,
      highlightFilter,
      ratingFilter,
      sort,
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
    sort,
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
    return () => window.clearTimeout(saveStatusTimerRef.current);
  }, []);

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
    const previousNormalizedItem = normalizeClientItem(previousItem ?? {});
    const nextNormalizedItem = normalizeClientItem(nextItem);
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
    setSavingArtworkIds((current) => addSetItem(current, id));
    window.clearTimeout(saveStatusTimerRef.current);
    setSaveStatus("saving");

    try {
      const response = await fetch("/api/curation", {
        method: "PATCH",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!response.ok) throw new Error("Failed to save curation");

      const result = (await response.json().catch(() => undefined)) as
        | {
            item?: ArtworkCurationItem;
            curation?: ArtworkCuration | ArtworkCurationItem;
          }
        | undefined;
      const savedNormalizedItem = normalizeClientItem(
        readSavedCurationItem(result, id) ?? nextNormalizedItem
      );

      setCuration((current) =>
        applyCurationItem(current, id, savedNormalizedItem)
      );
      setArtworks((current) =>
        current.map((artwork) =>
          artwork.id === id
            ? applyArtworkCuration(artwork, savedNormalizedItem)
            : artwork
        )
      );

      setTimedSaveStatus("saved");
      updateCatalogCurationStats(previousNormalizedItem, savedNormalizedItem);
    } catch {
      setCuration((current) => applyCurationItem(current, id, previousItem ?? {}));
      setArtworks((current) =>
        current.map((artwork) =>
          artwork.id === id
            ? applyArtworkCuration(artwork, previousItem ?? {})
            : artwork
        )
      );
      setTimedSaveStatus("error");
    } finally {
      setSavingArtworkIds((current) => removeSetItem(current, id));
    }
  }

  function setTimedSaveStatus(status: Exclude<SaveStatus, "idle" | "saving">) {
    window.clearTimeout(saveStatusTimerRef.current);
    setSaveStatus(status);
    saveStatusTimerRef.current = window.setTimeout(() => {
      setSaveStatus("idle");
    }, status === "saved" ? 1400 : 2600);
  }

  function updateCatalogCurationStats(
    previousItem: ArtworkCurationItem,
    nextItem: ArtworkCurationItem
  ) {
    const highlightedDelta =
      Number(nextItem.highlighted === true) -
      Number(previousItem.highlighted === true);
    const ratedDelta =
      Number(typeof nextItem.rating === "number") -
      Number(typeof previousItem.rating === "number");

    if (highlightedDelta === 0 && ratedDelta === 0) return;

    setCatalogMeta((current) => ({
      ...current,
      curation: {
        highlighted: Math.max(
          0,
          current.curation.highlighted + highlightedDelta
        ),
        rated: Math.max(0, current.curation.rated + ratedDelta),
      },
    }));
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
    const isSavingArtwork = savingArtworkIds.has(artwork.id);

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
            disabled={isSavingArtwork}
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
              disabled={isSavingArtwork}
              aria-pressed={item.rating === rating}
            >
              {rating}
            </button>
          ))}
        </div>
        {isSavingArtwork ? (
          <span className={styles.inlineSavingIndicator} role="status">
            <span className={styles.savingSpinner} aria-hidden="true" />
            Saving
          </span>
        ) : null}
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

    if (sort !== DEFAULT_SORT) {
      filters.push({
        key: "sort",
        label: `Sort: ${getSortLabel(sort)}`,
        onClear: () => {
          setSort(DEFAULT_SORT);
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
          <span>Sort by</span>
          <select
            value={sort}
            onChange={(event) => {
              setSort(event.target.value as ArtworkSort);
              resetToFirstPage();
            }}
          >
            {SORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
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
            setSort(DEFAULT_SORT);
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
              const { displayUrl, downloadUrl, isSvg } = getArtworkImageUrls(
                artwork,
                "overview"
              );
              const item = curation[artwork.id] ?? {};
              const isSavingArtwork = savingArtworkIds.has(artwork.id);
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
                        disabled={isSavingArtwork}
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
                  {isSavingArtwork ? (
                    <span
                      className={styles.cardSavingIndicator}
                      role="status"
                      aria-label="Saving curation"
                    >
                      <span className={styles.savingSpinner} aria-hidden="true" />
                    </span>
                  ) : null}

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
          key={selectedArtwork.id}
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
  const [previewMode, setPreviewMode] = useState<EpdPreviewMode>("original");
  const [epdControls, setEpdControls] = useState<EpdControls>(() =>
    createDefaultEpdControls(artwork)
  );
  const [epdPreviewUrl, setEpdPreviewUrl] = useState<string>();
  const [devicePreviewUrl, setDevicePreviewUrl] = useState<string>();
  const [epdStatus, setEpdStatus] = useState<
    "idle" | "rendering" | "ready" | "error"
  >("idle");
  const [epdMessage, setEpdMessage] = useState("");
  const [autoSummary, setAutoSummary] = useState<string>();
  const epdObjectUrlsRef = useRef<string[]>([]);
  const epdRunIdRef = useRef(0);
  const selectedPreviewUrl =
    previewMode === "device" ? devicePreviewUrl : epdPreviewUrl;
  const mediaUrl =
    previewMode === "original" ? displayUrl : selectedPreviewUrl ?? displayUrl;
  const mediaIsOriginal = previewMode === "original" || !selectedPreviewUrl;
  const selectedPalette = getEpdPalette(epdControls.paletteKey);

  useEffect(() => {
    if (previewMode === "original" || !displayUrl) return;

    const runId = epdRunIdRef.current + 1;
    epdRunIdRef.current = runId;
    let cancelled = false;

    async function renderEpdPreview() {
      setEpdStatus("rendering");
      setEpdMessage("Rendering e-paper preview");

      try {
        const sourceCanvas = await loadImageIntoDisplayCanvas(
          displayUrl,
          epdControls
        );
        if (cancelled || epdRunIdRef.current !== runId) return;

        const ditheredCanvas = document.createElement("canvas");
        ditheredCanvas.width = sourceCanvas.width;
        ditheredCanvas.height = sourceCanvas.height;

        const ditherOptions = resolveEpdDitherOptions(
          sourceCanvas,
          epdControls,
          selectedPalette
        );

        await ditherImage(sourceCanvas, ditheredCanvas, {
          ...ditherOptions,
          palette: selectedPalette,
        });
        if (cancelled || epdRunIdRef.current !== runId) return;

        const deviceCanvas = document.createElement("canvas");
        deviceCanvas.width = sourceCanvas.width;
        deviceCanvas.height = sourceCanvas.height;
        replaceColors(ditheredCanvas, deviceCanvas, selectedPalette);

        const [nextEpdUrl, nextDeviceUrl] = await Promise.all([
          canvasToObjectUrl(ditheredCanvas),
          canvasToObjectUrl(deviceCanvas),
        ]);
        if (cancelled || epdRunIdRef.current !== runId) {
          clearObjectUrls([nextEpdUrl, nextDeviceUrl]);
          return;
        }

        clearObjectUrls(epdObjectUrlsRef.current);
        epdObjectUrlsRef.current = [nextEpdUrl, nextDeviceUrl];
        setEpdPreviewUrl(nextEpdUrl);
        setDevicePreviewUrl(nextDeviceUrl);
        setEpdStatus("ready");
        setEpdMessage(
          formatEpdStatusMessage(
            epdControls,
            selectedPalette,
            sourceCanvas.width,
            sourceCanvas.height
          )
        );
      } catch (error) {
        if (cancelled || epdRunIdRef.current !== runId) return;
        setEpdPreviewUrl(undefined);
        setDevicePreviewUrl(undefined);
        setEpdStatus("error");
        setEpdMessage(
          error instanceof Error
            ? error.message
            : "Could not render the e-paper preview"
        );
      }
    }

    renderEpdPreview();

    return () => {
      cancelled = true;
    };
  }, [displayUrl, epdControls, previewMode, selectedPalette]);

  useEffect(() => {
    return () => {
      clearObjectUrls(epdObjectUrlsRef.current);
    };
  }, []);

  async function applyAutomaticEpdSettings() {
    if (!displayUrl) return;

    setEpdStatus("rendering");
    setEpdMessage("Analyzing image");

    try {
      const sourceCanvas = await loadImageIntoDisplayCanvas(
        displayUrl,
        epdControls
      );
      const suggestion = getAutoProcessingSuggestion(
        sourceCanvas,
        selectedPalette,
        epdControls
      );
      const suggested = suggestion.ditherOptions;

      setEpdControls((current) => ({
        ...current,
        ...controlsFromSuggestedOptions(suggested),
        processingPreset: "manual",
      }));
      setPreviewMode((current) => (current === "original" ? "dithered" : current));
      setAutoSummary(
        buildAutoSummary(suggestion.imageKind, suggestion.reasons)
      );
    } catch (error) {
      setEpdStatus("error");
      setEpdMessage(
        error instanceof Error
          ? error.message
          : "Could not analyze the image"
      );
    }
  }

  async function applyAutomaticImageAdjustments() {
    if (!displayUrl) return;

    setEpdStatus("rendering");
    setEpdMessage("Analyzing image adjustments");

    try {
      const sourceCanvas = await loadImageIntoDisplayCanvas(
        displayUrl,
        epdControls
      );
      const suggestion = suggestCanvasImageAdjustmentOptions(
        sourceCanvas,
        selectedPalette,
        { intent: epdControls.intent }
      );

      setEpdControls((current) => ({
        ...current,
        ...controlsFromSuggestedOptions(suggestion.adjustmentOptions),
        processingPreset: "manual",
      }));
      setPreviewMode((current) => (current === "original" ? "dithered" : current));
      setAutoSummary(
        buildAutoSummary(suggestion.imageKind, suggestion.reasons)
      );
    } catch (error) {
      setEpdStatus("error");
      setEpdMessage(
        error instanceof Error
          ? error.message
          : "Could not analyze the image adjustments"
      );
    }
  }

  function resetImageAdjustments() {
    setEpdControls((current) => ({
      ...current,
      ...getNeutralImageAdjustmentControls(),
      processingPreset: "manual",
    }));
    setAutoSummary(undefined);
    if (previewMode === "original") setPreviewMode("dithered");
  }

  function applyEpdPreset(processingPreset: EpdPresetKey) {
    setEpdControls((current) => ({
      ...current,
      ...controlsFromProcessingPreset(processingPreset),
      processingPreset,
    }));
    setAutoSummary(undefined);
    if (previewMode === "original") setPreviewMode("dithered");
  }

  function updateEpdControls(
    next: Partial<EpdControls>,
    options: { preservePreset?: boolean } = {}
  ) {
    const normalized = normalizeControlsFromInputs(next);
    setEpdControls((current) => ({
      ...current,
      ...normalized,
      processingPreset:
        options.preservePreset || normalized.processingPreset
          ? normalized.processingPreset ?? current.processingPreset
          : "manual",
    }));
    if (previewMode === "original") setPreviewMode("dithered");
  }

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
        {mediaUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={mediaUrl}
            alt={artwork.title}
            className={
              mediaIsOriginal && isSvg
                ? styles.previewImageContain
                : styles.previewImage
            }
          />
        ) : (
          <div className={styles.previewMissingImage}>No image</div>
        )}
        {previewMode !== "original" && epdStatus === "rendering" ? (
          <div className={styles.previewRenderStatus} role="status">
            <span className={styles.savingSpinner} aria-hidden="true" />
            Rendering
          </div>
        ) : null}
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

        <section className={styles.epdPanel} aria-label="E-paper preview tools">
          <div className={styles.epdPanelHeader}>
            <div>
              <h3>E-paper preview</h3>
              <p>
                {epdStatus === "error"
                  ? epdMessage
                  : epdMessage || "Tune colors for limited e-paper palettes."}
              </p>
            </div>
            <div className={styles.epdPanelActions}>
              <button
                type="button"
                className={styles.epdAutoButton}
                onClick={applyAutomaticEpdSettings}
                disabled={!displayUrl || epdStatus === "rendering"}
              >
                Auto settings
              </button>
            </div>
          </div>

          <div className={styles.segmentedControl} aria-label="Preview mode">
            {[
              ["original", "Original"],
              ["dithered", "Dithered"],
              ["device", "Device"],
            ].map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={
                  previewMode === value ? styles.segmentActive : undefined
                }
                onClick={() => setPreviewMode(value as EpdPreviewMode)}
                aria-pressed={previewMode === value}
              >
                {label}
              </button>
            ))}
          </div>

          <div className={styles.epdStepList}>
            <section className={styles.epdStep} aria-label="Display">
              <h4>Display</h4>
              <div className={styles.epdControlGrid}>
                <label className={styles.epdField}>
                  <span>Palette</span>
                  <select
                    value={epdControls.paletteKey}
                    onChange={(event) =>
                      updateEpdControls(
                        { paletteKey: event.target.value as EpdPaletteKey },
                        { preservePreset: true }
                      )
                    }
                  >
                    {EPD_PALETTE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className={styles.epdField}>
                  <span>Canvas</span>
                  <select
                    value={epdControls.canvasPreset}
                    onChange={(event) =>
                      updateEpdControls(
                        {
                          canvasPreset: event.target.value as EpdCanvasPreset,
                        },
                        { preservePreset: true }
                      )
                    }
                  >
                    {EPD_CANVAS_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className={styles.epdField}>
                  <span>Orientation</span>
                  <select
                    value={epdControls.canvasOrientation}
                    onChange={(event) =>
                      updateEpdControls(
                        {
                          canvasOrientation: event.target
                            .value as EpdCanvasOrientation,
                        },
                        { preservePreset: true }
                      )
                    }
                  >
                    {EPD_ORIENTATION_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className={styles.epdField}>
                  <span>Image fill</span>
                  <select
                    value={epdControls.imageFit}
                    onChange={(event) =>
                      updateEpdControls(
                        { imageFit: event.target.value as EpdImageFit },
                        { preservePreset: true }
                      )
                    }
                  >
                    {EPD_IMAGE_FIT_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </section>

            <section className={styles.epdStep} aria-label="Processing preset">
              <h4>Preset</h4>
              <div className={styles.epdControlGrid}>
                <label className={`${styles.epdField} ${styles.epdFieldFull}`}>
                  <span>Preset</span>
                  <select
                    value={epdControls.processingPreset}
                    onChange={(event) =>
                      applyEpdPreset(coerceEpdPresetKey(event.target.value))
                    }
                  >
                    {EPD_PRESET_OPTIONS.map((option) => (
                      <option
                        key={option.value}
                        value={option.value}
                        title={option.title}
                      >
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className={styles.epdField}>
                  <span>Auto flow</span>
                  <select
                    value={epdControls.autoFlow}
                    onChange={(event) =>
                      updateEpdControls(
                        { autoFlow: event.target.value as EpdAutoFlow },
                        { preservePreset: true }
                      )
                    }
                  >
                    {EPD_AUTO_FLOW_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className={styles.epdField}>
                  <span>Auto goal</span>
                  <select
                    value={epdControls.intent}
                    onChange={(event) =>
                      updateEpdControls(
                        {
                          intent: event.target.value as AutoProcessingIntent,
                        },
                        { preservePreset: true }
                      )
                    }
                  >
                    {EPD_INTENT_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className={styles.epdActionRow}>
                <button
                  type="button"
                  className={styles.epdAutoButton}
                  onClick={applyAutomaticImageAdjustments}
                  disabled={!displayUrl || epdStatus === "rendering"}
                >
                  Auto image adjustments
                </button>
                <button
                  type="button"
                  className={styles.epdAutoButton}
                  onClick={resetImageAdjustments}
                  disabled={epdStatus === "rendering"}
                >
                  Reset image adjustments
                </button>
              </div>
            </section>

            <section
              className={styles.epdStep}
              aria-label="Image tone adjustments"
            >
              <h4>Image tone adjustments</h4>
              <div className={styles.epdSliders}>
                <RangeControl
                  label="Exposure"
                  value={epdControls.exposure}
                  min={-1}
                  max={1}
                  step={0.05}
                  onChange={(exposure) => updateEpdControls({ exposure })}
                />
                <RangeControl
                  label="Saturation"
                  value={epdControls.saturation}
                  min={-1}
                  max={1}
                  step={0.05}
                  onChange={(saturation) => updateEpdControls({ saturation })}
                />
                <RangeControl
                  label="Contrast"
                  value={epdControls.contrast}
                  min={-1}
                  max={1}
                  step={0.05}
                  onChange={(contrast) => updateEpdControls({ contrast })}
                />
                <RangeControl
                  label="Clarity"
                  value={epdControls.clarity}
                  min={-1}
                  max={1}
                  step={0.02}
                  onChange={(clarity) => updateEpdControls({ clarity })}
                />
                <RangeControl
                  label="Shadows"
                  value={epdControls.shadowBoost}
                  min={-1}
                  max={1}
                  step={0.05}
                  onChange={(shadowBoost) =>
                    updateEpdControls({ shadowBoost })
                  }
                />
                <RangeControl
                  label="Highlights"
                  value={epdControls.highlightCompress}
                  min={-1.5}
                  max={1}
                  step={0.05}
                  onChange={(highlightCompress) =>
                    updateEpdControls({ highlightCompress })
                  }
                />
              </div>
            </section>

            <section className={styles.epdStep} aria-label="Image range fitting">
              <h4>Image range fitting</h4>
              <div className={styles.epdControlGrid}>
                <label className={styles.epdField}>
                  <span>Mode</span>
                  <select
                    value={epdControls.dynamicRangeMode}
                    onChange={(event) =>
                      updateEpdControls({
                        dynamicRangeMode: event.target
                          .value as EpdControls["dynamicRangeMode"],
                      })
                    }
                  >
                    <option value="off">Off</option>
                    <option value="display">Display</option>
                    <option value="auto">Auto</option>
                  </select>
                </label>

                <RangeControl
                  label="Strength"
                  value={epdControls.dynamicRangeStrength}
                  min={0}
                  max={1}
                  step={0.05}
                  onChange={(dynamicRangeStrength) =>
                    updateEpdControls({ dynamicRangeStrength })
                  }
                />

                <NumberControl
                  label="Low %"
                  value={epdControls.lowPercentile}
                  min={0}
                  max={0.25}
                  step={0.005}
                  disabled={epdControls.dynamicRangeMode !== "auto"}
                  onChange={(lowPercentile) =>
                    updateEpdControls({ lowPercentile })
                  }
                />

                <NumberControl
                  label="High %"
                  value={epdControls.highPercentile}
                  min={0.75}
                  max={1}
                  step={0.005}
                  disabled={epdControls.dynamicRangeMode !== "auto"}
                  onChange={(highPercentile) =>
                    updateEpdControls({ highPercentile })
                  }
                />
              </div>
            </section>

            <section
              className={styles.epdStep}
              aria-label="Canvas dithering and matching"
            >
              <h4>Canvas dithering and matching</h4>
              <div className={styles.epdControlGrid}>
                <label className={styles.epdField}>
                  <span>Matching</span>
                  <select
                    value={epdControls.colorMatching}
                    onChange={(event) =>
                      updateEpdControls({
                        colorMatching: event.target.value as ColorMatchingMode,
                      })
                    }
                  >
                    {EPD_COLOR_MATCHING_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className={styles.epdField}>
                  <span>Engine</span>
                  <select
                    value={epdControls.processingEngine}
                    onChange={(event) =>
                      updateEpdControls({
                        processingEngine: event.target
                          .value as DitherProcessingEngine,
                      })
                    }
                    disabled={epdControls.ditheringType !== "errorDiffusion"}
                  >
                    {EPD_PROCESSING_ENGINE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className={styles.epdField}>
                  <span>Type</span>
                  <select
                    value={epdControls.ditheringType}
                    onChange={(event) =>
                      updateEpdControls({
                        ditheringType: event.target.value as EpdDitherType,
                      })
                    }
                  >
                    {EPD_DITHER_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className={styles.epdField}>
                  <span>Kernel</span>
                  <select
                    value={epdControls.errorDiffusionMatrix}
                    onChange={(event) =>
                      updateEpdControls({
                        errorDiffusionMatrix: event.target.value,
                      })
                    }
                    disabled={!usesKernelDithering(epdControls.ditheringType)}
                  >
                    {EPD_DIFFUSION_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className={styles.epdCheckbox}>
                  <input
                    type="checkbox"
                    checked={epdControls.serpentine}
                    disabled={!usesKernelDithering(epdControls.ditheringType)}
                    onChange={(event) =>
                      updateEpdControls({ serpentine: event.target.checked })
                    }
                  />
                  <span>Serpentine</span>
                </label>

                <label className={styles.epdField}>
                  <span>Random</span>
                  <select
                    value={epdControls.randomDitheringType}
                    onChange={(event) =>
                      updateEpdControls({
                        randomDitheringType: event.target
                          .value as EpdRandomDitherType,
                      })
                    }
                    disabled={epdControls.ditheringType !== "random"}
                  >
                    {EPD_RANDOM_DITHER_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>

                <NumberControl
                  label="Matrix W"
                  value={epdControls.orderedMatrixWidth}
                  min={1}
                  max={16}
                  step={1}
                  disabled={!usesOrderedDithering(epdControls.ditheringType)}
                  onChange={(orderedMatrixWidth) =>
                    updateEpdControls({ orderedMatrixWidth })
                  }
                />

                <NumberControl
                  label="Matrix H"
                  value={epdControls.orderedMatrixHeight}
                  min={1}
                  max={16}
                  step={1}
                  disabled={!usesOrderedDithering(epdControls.ditheringType)}
                  onChange={(orderedMatrixHeight) =>
                    updateEpdControls({ orderedMatrixHeight })
                  }
                />
              </div>

              <div className={styles.epdSliders}>
                <div className={styles.epdToggleRow}>
                  <label className={styles.epdCheckbox}>
                    <input
                      type="checkbox"
                      checked={epdControls.edgePreservation}
                      onChange={(event) =>
                        updateEpdControls({
                          edgePreservation: event.target.checked,
                        })
                      }
                    />
                    <span>Edge core</span>
                  </label>
                  <label className={styles.epdCheckbox}>
                    <input
                      type="checkbox"
                      checked={epdControls.edgeAntialiasing}
                      onChange={(event) =>
                        updateEpdControls({
                          edgeAntialiasing: event.target.checked,
                        })
                      }
                    />
                    <span>Anti-tooth band</span>
                  </label>
                </div>
                <RangeControl
                  label="Edge strength"
                  value={epdControls.edgePreservationStrength}
                  min={0}
                  max={1}
                  step={0.05}
                  disabled={!epdControls.edgePreservation}
                  onChange={(edgePreservationStrength) =>
                    updateEpdControls({ edgePreservationStrength })
                  }
                />
                <RangeControl
                  label="Band strength"
                  value={epdControls.edgeAntialiasingStrength}
                  min={0}
                  max={1}
                  step={0.05}
                  disabled={!epdControls.edgeAntialiasing}
                  onChange={(edgeAntialiasingStrength) =>
                    updateEpdControls({ edgeAntialiasingStrength })
                  }
                />
              </div>
            </section>
          </div>

          {autoSummary ? (
            <p className={styles.epdAutoSummary}>{autoSummary}</p>
          ) : null}
        </section>

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

function RangeControl({
  label,
  value,
  min,
  max,
  step,
  disabled = false,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <label className={styles.rangeControl}>
      <span>
        {label}
        <output>{formatControlValue(value)}</output>
      </span>
      <input
        type="range"
        value={value}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

function NumberControl({
  label,
  value,
  min,
  max,
  step,
  disabled = false,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <label className={styles.epdField}>
      <span>{label}</span>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

function getEpdPalette(key: EpdPaletteKey) {
  return (
    EPD_PALETTE_OPTIONS.find((option) => option.value === key)?.palette ??
    aitjcizeSpectra6Palette
  );
}

function resolveEpdDitherOptions(
  sourceCanvas: HTMLCanvasElement,
  controls: EpdControls,
  palette: PaletteColorEntry[]
): Partial<DitherImageOptions> {
  const manualOptions = buildEpdDitherOptions(controls);

  if (controls.processingPreset === "auto") {
    return getAutoProcessingSuggestion(sourceCanvas, palette, controls)
      .ditherOptions;
  }

  if (controls.processingPreset === "autoDitherManual") {
    const autoDitherOptions = getAutoProcessingSuggestion(
      sourceCanvas,
      palette,
      controls
    ).ditherOptions;

    return {
      ...autoDitherOptions,
      ...buildEpdImageAdjustmentOptions(controls),
    };
  }

  return manualOptions;
}

function getAutoProcessingSuggestion(
  sourceCanvas: HTMLCanvasElement,
  palette: PaletteColorEntry[],
  controls: EpdControls
) {
  const options = { intent: controls.intent };

  return controls.autoFlow === "previous"
    ? suggestCanvasProcessingOptions(sourceCanvas, palette, options)
    : suggestLayeredCanvasProcessingOptions(sourceCanvas, palette, options);
}

function buildEpdDitherOptions(controls: EpdControls): Partial<DitherImageOptions> {
  const imageAdjustmentOptions = buildEpdImageAdjustmentOptions(controls);
  const edgePreservation = {
    enabled: controls.edgePreservation,
    strength: controls.edgePreservationStrength,
  };
  const edgeAntialiasing = {
    enabled: controls.edgeAntialiasing,
    strength: controls.edgeAntialiasingStrength,
  };

  return {
    ditheringType: controls.ditheringType,
    colorMatching: controls.colorMatching,
    processingEngine: controls.processingEngine,
    ...imageAdjustmentOptions,
    ...(usesKernelDithering(controls.ditheringType)
      ? {
          errorDiffusionMatrix: controls.errorDiffusionMatrix,
          serpentine: controls.serpentine,
        }
      : {}),
    ...(usesOrderedDithering(controls.ditheringType)
      ? {
          orderedDitheringType: "bayer",
          orderedDitheringMatrix: [
            clampNumber(controls.orderedMatrixWidth, 1, 16),
            clampNumber(controls.orderedMatrixHeight, 1, 16),
          ] as [number, number],
        }
      : {}),
    ...(controls.ditheringType === "random"
      ? { randomDitheringType: controls.randomDitheringType }
      : {}),
    ...(controls.edgePreservation ? { edgePreservation } : {}),
    ...(controls.edgeAntialiasing ? { edgeAntialiasing } : {}),
  };
}

function buildEpdImageAdjustmentOptions(
  controls: EpdControls
): Partial<DitherImageOptions> {
  const clarity = getClarityOptions(controls.clarity);

  return {
    toneMapping: buildEpdToneMappingOptions(controls),
    dynamicRangeCompression:
      controls.dynamicRangeMode === "off"
        ? { mode: "off" as const }
        : {
            mode: controls.dynamicRangeMode,
            strength: controls.dynamicRangeStrength,
            ...(controls.dynamicRangeMode === "auto"
              ? {
                  lowPercentile: controls.lowPercentile,
                  highPercentile: controls.highPercentile,
                  preserveWhite: true,
                  whitePreservePercentile: 0.99,
                  whitePreserveMinLuma: 150,
                }
              : {}),
          },
    ...(clarity ? { clarity } : {}),
    ...(controls.paperNormalization
      ? {
          paperNormalization: {
            mode: "warmPaper" as const,
            strength: 0.8,
          },
        }
      : {}),
  };
}

function buildEpdToneMappingOptions(controls: EpdControls) {
  const hasCurveAdjustment =
    !numbersEqual(controls.shadowBoost, 0) ||
    !numbersEqual(controls.highlightCompress, 0);

  return {
    exposure: controls.exposure,
    saturation: controls.saturation,
    contrast: controls.contrast,
    strength: hasCurveAdjustment
      ? controls.scurveStrength || 0.85
      : controls.scurveStrength,
    shadowBoost: controls.shadowBoost,
    highlightCompress: controls.highlightCompress,
    midpoint: 0.5,
  };
}

function getClarityOptions(amount: number) {
  if (numbersEqual(amount, 0)) return undefined;

  return {
    amount: Math.sign(amount) * Math.pow(Math.abs(amount), 1.1),
    radius: 2,
    midtone: 1.2,
  };
}

function getClaritySliderValue(
  clarity: DitherImageOptions["clarity"] | undefined
) {
  const amount = clarity?.amount;
  if (typeof amount !== "number") return 0;

  return Math.sign(amount) * Math.pow(Math.abs(amount), 1 / 1.1);
}

function getNeutralImageAdjustmentControls(): Partial<EpdControls> {
  return {
    exposure: 0,
    saturation: 0,
    contrast: 0,
    clarity: 0,
    scurveStrength: 0,
    shadowBoost: 0,
    highlightCompress: 0,
    dynamicRangeMode: "off",
    dynamicRangeStrength: 1,
    lowPercentile: 0.01,
    highPercentile: 0.99,
    paperNormalization: false,
  };
}

function controlsFromSuggestedOptions(
  options: Partial<DitherImageOptions>
): Partial<EpdControls> {
  const toneMapping = options.toneMapping;
  const dynamicRange =
    typeof options.dynamicRangeCompression === "object"
      ? options.dynamicRangeCompression
      : undefined;
  const next: Partial<EpdControls> = {
    ...(isEpdDitherType(options.ditheringType)
      ? { ditheringType: options.ditheringType }
      : {}),
    ...(isColorMatchingMode(options.colorMatching)
      ? { colorMatching: options.colorMatching }
      : {}),
    ...(typeof options.errorDiffusionMatrix === "string"
      ? { errorDiffusionMatrix: options.errorDiffusionMatrix }
      : {}),
    ...(typeof options.serpentine === "boolean"
      ? { serpentine: options.serpentine }
      : {}),
    ...(isEpdRandomDitherType(options.randomDitheringType)
      ? { randomDitheringType: options.randomDitheringType }
      : {}),
    ...(Array.isArray(options.orderedDitheringMatrix)
      ? {
          orderedMatrixWidth: Number(options.orderedDitheringMatrix[0] ?? 4),
          orderedMatrixHeight: Number(options.orderedDitheringMatrix[1] ?? 4),
        }
      : {}),
    ...(options.processingEngine === "auto" ||
    options.processingEngine === "js" ||
    options.processingEngine === "wasm"
      ? { processingEngine: options.processingEngine }
      : {}),
    ...(options.paperNormalization?.mode === "warmPaper"
      ? { paperNormalization: true }
      : {}),
    ...(options.clarity ? { clarity: getClaritySliderValue(options.clarity) } : {}),
    ...(dynamicRange?.mode === "off" ||
    dynamicRange?.mode === "display" ||
    dynamicRange?.mode === "auto"
      ? { dynamicRangeMode: dynamicRange.mode }
      : {}),
    ...(typeof dynamicRange?.strength === "number"
      ? { dynamicRangeStrength: dynamicRange.strength }
      : {}),
    ...(typeof dynamicRange?.lowPercentile === "number"
      ? { lowPercentile: dynamicRange.lowPercentile }
      : {}),
    ...(typeof dynamicRange?.highPercentile === "number"
      ? { highPercentile: dynamicRange.highPercentile }
      : {}),
    ...(typeof options.edgePreservation?.enabled === "boolean"
      ? { edgePreservation: options.edgePreservation.enabled }
      : {}),
    ...(typeof options.edgePreservation?.strength === "number"
      ? { edgePreservationStrength: options.edgePreservation.strength }
      : {}),
    ...(typeof options.edgeAntialiasing?.enabled === "boolean"
      ? { edgeAntialiasing: options.edgeAntialiasing.enabled }
      : {}),
    ...(typeof options.edgeAntialiasing?.strength === "number"
      ? { edgeAntialiasingStrength: options.edgeAntialiasing.strength }
      : {}),
  };

  if (
    toneMapping?.mode === "scurve" ||
    typeof toneMapping?.strength === "number" ||
    typeof toneMapping?.shadowBoost === "number" ||
    typeof toneMapping?.highlightCompress === "number"
  ) {
    if (typeof toneMapping.strength === "number") {
      next.scurveStrength = toneMapping.strength;
    }
    if (typeof toneMapping.shadowBoost === "number") {
      next.shadowBoost = toneMapping.shadowBoost;
    }
    if (typeof toneMapping.highlightCompress === "number") {
      next.highlightCompress = toneMapping.highlightCompress;
    }
  }

  if (typeof toneMapping?.exposure === "number") {
    next.exposure = toneMapping.exposure;
  }

  if (typeof toneMapping?.saturation === "number") {
    next.saturation = toneMapping.saturation;
  }

  if (typeof toneMapping?.contrast === "number") {
    next.contrast = toneMapping.contrast;
  }

  return next;
}

function controlsFromProcessingPreset(
  processingPreset: EpdPresetKey
): Partial<EpdControls> {
  if (
    processingPreset === "auto" ||
    processingPreset === "autoDitherManual" ||
    processingPreset === "manual"
  ) {
    return {};
  }

  const preset = getProcessingPreset(processingPreset);
  if (!preset) return {};

  return controlsFromSuggestedOptions({
    processingPreset,
    toneMapping: preset.toneMapping,
    dynamicRangeCompression: preset.dynamicRangeCompression,
    colorMatching: preset.colorMatching,
    errorDiffusionMatrix: preset.errorDiffusionMatrix,
    paperNormalization: preset.paperNormalization,
  });
}

function usesKernelDithering(ditheringType: EpdDitherType) {
  return (
    ditheringType === "errorDiffusion" ||
    ditheringType === "ditherItErrorDiffusion"
  );
}

function usesOrderedDithering(ditheringType: EpdDitherType) {
  return ditheringType === "ordered" || ditheringType === "ditherItOrdered";
}

function clampNumber(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function numbersEqual(a: number | undefined, b: number | undefined) {
  return a === b || Math.abs((a ?? 0) - (b ?? 0)) < 0.000001;
}

function isEpdPresetKey(value: unknown): value is EpdPresetKey {
  return EPD_PRESET_OPTIONS.some((option) => option.value === value);
}

function selectedPresetLabel(value: EpdPresetKey) {
  return EPD_PRESET_OPTIONS.find((option) => option.value === value)?.label;
}

function formatEpdStatusMessage(
  controls: EpdControls,
  palette: PaletteColorEntry[],
  width: number,
  height: number
) {
  const presetLabel = selectedPresetLabel(controls.processingPreset);
  return [
    presetLabel,
    `${palette.length} colors`,
    `${width} x ${height}`,
    controls.imageFit,
  ]
    .filter(Boolean)
    .join(", ");
}

function coerceEpdPresetKey(value: string): EpdPresetKey {
  return isEpdPresetKey(value) ? value : "manual";
}

function coerceMatrixSize(value: number) {
  return Math.round(clampNumber(value, 1, 16));
}

function clampPercentile(value: number, fallback: number) {
  return Number.isFinite(value) ? clampNumber(value, 0, 1) : fallback;
}

function normalizeControlsFromInputs(next: Partial<EpdControls>) {
  const normalized = { ...next };
  if (typeof normalized.orderedMatrixWidth === "number") {
    normalized.orderedMatrixWidth = coerceMatrixSize(normalized.orderedMatrixWidth);
  }
  if (typeof normalized.orderedMatrixHeight === "number") {
    normalized.orderedMatrixHeight = coerceMatrixSize(
      normalized.orderedMatrixHeight
    );
  }
  if (typeof normalized.lowPercentile === "number") {
    normalized.lowPercentile = clampPercentile(normalized.lowPercentile, 0.01);
  }
  if (typeof normalized.highPercentile === "number") {
    normalized.highPercentile = clampPercentile(normalized.highPercentile, 0.99);
  }

  return normalized;
}

function isEpdDitherType(value: unknown): value is EpdDitherType {
  return EPD_DITHER_OPTIONS.some((option) => option.value === value);
}

function isColorMatchingMode(value: unknown): value is ColorMatchingMode {
  return EPD_COLOR_MATCHING_OPTIONS.some((option) => option.value === value);
}

function isEpdRandomDitherType(value: unknown): value is EpdRandomDitherType {
  return EPD_RANDOM_DITHER_OPTIONS.some((option) => option.value === value);
}

function readableImageKind(value: string) {
  return value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (letter) => letter.toUpperCase());
}

function buildAutoSummary(imageKind: string, reasons: string[]) {
  const normalizedKind = imageKind.toLowerCase();
  const summaryParts = reasons
    .map((reason) => reason.replace(/[.?!]+$/g, "").trim())
    .filter(Boolean)
    .filter((reason) => !reason.toLowerCase().includes(normalizedKind))
    .slice(0, 2);

  return [`Auto: ${readableImageKind(imageKind)}`, ...summaryParts]
    .map((part) => `${part}.`)
    .join(" ");
}

function formatControlValue(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

async function loadImageIntoDisplayCanvas(src: string, controls: EpdControls) {
  const image = await loadHtmlImage(src);
  const naturalWidth = image.naturalWidth || image.width;
  const naturalHeight = image.naturalHeight || image.height;

  if (!naturalWidth || !naturalHeight) {
    throw new Error("Image has no readable dimensions");
  }

  const { width, height } = getEpdCanvasDimensions(
    controls.canvasPreset,
    controls.canvasOrientation
  );
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Canvas is not available in this browser");

  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(
    image,
    ...getImageDrawRect(
      naturalWidth,
      naturalHeight,
      canvas.width,
      canvas.height,
      controls.imageFit
    )
  );

  try {
    context.getImageData(0, 0, 1, 1);
  } catch {
    throw new Error("This image cannot be processed because it blocks canvas access");
  }

  return canvas;
}

function getEpdCanvasDimensions(
  preset: EpdCanvasPreset,
  orientation: EpdCanvasOrientation
) {
  const [baseWidth, baseHeight] = preset.split("x").map(Number);
  const isLandscape = orientation === "landscape";
  const width = isLandscape
    ? Math.max(baseWidth, baseHeight)
    : Math.min(baseWidth, baseHeight);
  const height = isLandscape
    ? Math.min(baseWidth, baseHeight)
    : Math.max(baseWidth, baseHeight);

  return { width, height };
}

function getImageDrawRect(
  imageWidth: number,
  imageHeight: number,
  canvasWidth: number,
  canvasHeight: number,
  fit: EpdImageFit
): [number, number, number, number] {
  const scale =
    fit === "cover"
      ? Math.max(canvasWidth / imageWidth, canvasHeight / imageHeight)
      : Math.min(canvasWidth / imageWidth, canvasHeight / imageHeight);
  const drawWidth = imageWidth * scale;
  const drawHeight = imageHeight * scale;

  return [
    (canvasWidth - drawWidth) / 2,
    (canvasHeight - drawHeight) / 2,
    drawWidth,
    drawHeight,
  ];
}

function loadHtmlImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not load the image for processing"));
    image.src = src;
  });
}

function canvasToObjectUrl(canvas: HTMLCanvasElement) {
  return new Promise<string>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("Could not export the processed preview"));
        return;
      }

      resolve(URL.createObjectURL(blob));
    }, "image/png");
  });
}

function clearObjectUrls(urls: string[]) {
  for (const url of urls) URL.revokeObjectURL(url);
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

function addSetItem<T>(items: Set<T>, item: T) {
  const next = new Set(items);
  next.add(item);
  return next;
}

function removeSetItem<T>(items: Set<T>, item: T) {
  const next = new Set(items);
  next.delete(item);
  return next;
}

function readSavedCurationItem(
  result:
    | {
        item?: ArtworkCurationItem;
        curation?: ArtworkCuration | ArtworkCurationItem;
      }
    | undefined,
  id: string
): ArtworkCurationItem | undefined {
  if (!result) return undefined;
  if (result.item) return result.item;
  if (!result.curation) return undefined;

  if (isCurationItem(result.curation)) return result.curation;

  const item = result.curation[id];
  return item && isCurationItem(item) ? item : undefined;
}

function isCurationItem(value: unknown): value is ArtworkCurationItem {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;

  const candidate = value as ArtworkCurationItem;
  return "highlighted" in candidate || "rating" in candidate;
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
    sort: parseArtworkSort(params.get("sort")),
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
    sort: DEFAULT_SORT,
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
    "sort",
    filters.sort === DEFAULT_SORT ? "" : filters.sort
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

function parseArtworkSort(value: string | null): ArtworkSort {
  return SORT_OPTIONS.some((option) => option.value === value)
    ? (value as ArtworkSort)
    : DEFAULT_SORT;
}

function getSortLabel(value: ArtworkSort) {
  return (
    SORT_OPTIONS.find((option) => option.value === value)?.label ??
    SORT_OPTIONS[0].label
  );
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

function getArtworkImageUrls(
  artwork: Artwork,
  context: "overview" | "preview" = "preview"
) {
  const displayUrl =
    context === "overview"
      ? artwork.image.localResizedPaths?.["512"] ??
        artwork.image.localResizedPaths?.["1024"] ??
        artwork.image.localOriginalPath ??
        artwork.image.originalUrl
      : artwork.image.localResizedPaths?.["1024"] ??
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
  sort,
  pageSize,
  offset,
}: {
  query: string;
  sourceFilter: SourceFilter;
  highlightFilter: HighlightFilter;
  ratingFilter: RatingFilter;
  sort: ArtworkSort;
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
  setOrDeleteParam(params, "sort", sort === DEFAULT_SORT ? "" : sort);
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
