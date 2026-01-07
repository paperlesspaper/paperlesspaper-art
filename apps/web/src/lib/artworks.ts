import fs from "node:fs/promises";
import path from "node:path";

export type Artwork = {
  id: string;
  source: "met" | "artic" | "svgrepo";
  sourceId: string;
  title: string;
  description?: string;
  artist?: string;
  date?: string;
  isPublicDomain: boolean;
  license: string;
  licenseUrl?: string;
  rights?: string;
  sourceUrl: string;
  collection?: {
    name: string;
    url: string;
  };
  author?: {
    name: string;
    url: string;
  };
  tags?: string[];
  image: {
    originalUrl: string;
    localOriginalPath?: string;
    localResizedPaths?: Record<string, string>;
  };
  search: {
    query: string;
    downloadedAt: string;
  };
};

function dataFilePath() {
  return path.join(process.cwd(), "data", "artworks.json");
}

export async function loadArtworks(): Promise<Artwork[]> {
  try {
    const raw = await fs.readFile(dataFilePath(), "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Artwork[]) : [];
  } catch {
    return [];
  }
}
