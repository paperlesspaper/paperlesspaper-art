import path from "node:path";
import type { Artwork } from "./artwork.js";

type ArtworkPostgresModule = {
  closeArtworkDatabase: () => Promise<void>;
  isArtworkDatabaseConfigured: () => boolean;
  loadArtworkDuplicateIndexFromDatabase: () => Promise<Array<{ id: string }>>;
  loadWikimediaPreviewDecisionsFromDatabase: () => Promise<
    Array<{
      id: string;
      sourceId: string;
      decision: WikimediaPreviewDecision;
      rating?: number | null;
    }>
  >;
  setArtworkCurationRatingInDatabase: (
    id: string,
    rating: number
  ) => Promise<boolean>;
  upsertArtworkInDatabase: (artwork: Artwork) => Promise<ArtworkUpsertResult>;
  upsertWikimediaPreviewDecisionInDatabase: (
    decision: WikimediaPreviewDecisionRecord
  ) => Promise<boolean>;
};

type ArtworkUpsertResult = {
  inserted: boolean;
  updated: boolean;
};

export type WikimediaPreviewDecision = "pending" | "approved" | "rejected";

export type WikimediaPreviewDecisionRecord = {
  id: string;
  sourceId: string;
  title: string;
  query?: string;
  decision: WikimediaPreviewDecision;
  previewUrl?: string;
  previewLocalPath?: string;
  sourceUrl?: string;
  decidedAt?: string;
  metadata?: Record<string, unknown>;
};

export async function upsertArtworks(params: { artworks: Artwork[] }) {
  const database = await loadArtworkPostgres();
  let inserted = 0;
  let updated = 0;

  for (const artwork of params.artworks) {
    const result = await database.upsertArtworkInDatabase(artwork);
    if (result.inserted) inserted++;
    if (result.updated) updated++;
  }

  return {
    inserted,
    updated,
    addedOrUpdated: inserted + updated,
  };
}

export async function upsertArtwork(artwork: Artwork) {
  return upsertArtworks({ artworks: [artwork] });
}

export async function loadWikimediaPreviewDecisions() {
  const database = await loadArtworkPostgres();
  const decisions = await database.loadWikimediaPreviewDecisionsFromDatabase();
  return new Map(
    decisions.flatMap((decision) =>
      decision.decision === "approved" || decision.decision === "rejected"
        ? [[decision.id, decision.decision] as const]
        : []
    )
  );
}

export async function loadWikimediaPreviewDecisionRatings() {
  const database = await loadArtworkPostgres();
  const decisions = await database.loadWikimediaPreviewDecisionsFromDatabase();
  return new Map(
    decisions.flatMap((decision) =>
      decision.decision === "approved" && isRating(decision.rating)
        ? [[decision.id, decision.rating] as const]
        : []
    )
  );
}

export async function setArtworkCurationRating(id: string, rating: number) {
  const database = await loadArtworkPostgres();
  await database.setArtworkCurationRatingInDatabase(id, rating);
}

export async function upsertWikimediaPreviewDecision(
  decision: WikimediaPreviewDecisionRecord
) {
  const database = await loadArtworkPostgres();
  await database.upsertWikimediaPreviewDecisionInDatabase(decision);
}

function isRating(value: unknown): value is 1 | 2 | 3 | 4 | 5 {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 5
  );
}

export async function loadExistingArtworkIds() {
  const database = await loadArtworkPostgres();
  const artworks = await database.loadArtworkDuplicateIndexFromDatabase();
  return new Set(artworks.map((artwork) => artwork.id));
}

export async function closeArtworkStore() {
  const database = await loadArtworkPostgres();
  await database.closeArtworkDatabase();
}

export function defaultWebPaths(webRoot: string) {
  return {
    imagesRoot: path.join(webRoot, "public", "images"),
  };
}

async function loadArtworkPostgres() {
  const moduleUrl = new URL("../scripts/artwork-postgres.mjs", import.meta.url);
  const database = (await import(moduleUrl.href)) as ArtworkPostgresModule;

  if (!database.isArtworkDatabaseConfigured()) {
    throw new Error(
      "DATABASE_URL or POSTGRES_URL is required; static catalog JSON output has been removed"
    );
  }

  return database;
}
