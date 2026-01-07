import path from "node:path";
import { readJsonFile, writeJsonAtomic } from "./fsutil.js";
import type { Artwork } from "./artwork.js";

export async function upsertArtworks(params: {
  dataFilePath: string;
  artworks: Artwork[];
}) {
  const existing = await readJsonFile<Artwork[]>(params.dataFilePath, []);
  const byId = new Map(existing.map((a) => [a.id, a]));

  for (const artwork of params.artworks) {
    byId.set(artwork.id, artwork);
  }

  const merged = [...byId.values()].sort((a, b) => {
    const at = a.search?.downloadedAt ?? "";
    const bt = b.search?.downloadedAt ?? "";
    return bt.localeCompare(at);
  });

  await writeJsonAtomic(params.dataFilePath, merged);
  return { total: merged.length, addedOrUpdated: params.artworks.length };
}

export function defaultWebPaths(webRoot: string) {
  return {
    dataFilePath: path.join(webRoot, "data", "artworks.json"),
    imagesRoot: path.join(webRoot, "public", "images"),
  };
}
