import path from "node:path";
import type { Artwork } from "./artwork.js";

type ArtworkPostgresModule = {
  closeArtworkDatabase: () => Promise<void>;
  isArtworkDatabaseConfigured: () => boolean;
  upsertArtworkInDatabase: (artwork: Artwork) => Promise<boolean>;
};

export async function upsertArtworks(params: { artworks: Artwork[] }) {
  const database = await loadArtworkPostgres();

  for (const artwork of params.artworks) {
    await database.upsertArtworkInDatabase(artwork);
  }

  return { addedOrUpdated: params.artworks.length };
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
