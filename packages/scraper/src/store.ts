import path from "node:path";
import type { Artwork } from "./artwork.js";

type ArtworkPostgresModule = {
  closeArtworkDatabase: () => Promise<void>;
  isArtworkDatabaseConfigured: () => boolean;
  loadArtworkDuplicateIndexFromDatabase: () => Promise<Array<{ id: string }>>;
  upsertArtworkInDatabase: (artwork: Artwork) => Promise<ArtworkUpsertResult>;
};

type ArtworkUpsertResult = {
  inserted: boolean;
  updated: boolean;
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
