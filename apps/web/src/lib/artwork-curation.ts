import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";

export type ArtworkCurationItem = {
  highlighted?: boolean;
  rating?: 1 | 2 | 3 | 4 | 5;
};

export type ArtworkCuration = Record<string, ArtworkCurationItem>;

export function curationFilePath() {
  return path.join(process.cwd(), "data", "artwork-curation.json");
}

export async function loadArtworkCuration(): Promise<ArtworkCuration> {
  try {
    const raw = await fsPromises.readFile(curationFilePath(), "utf8");
    return parseArtworkCuration(JSON.parse(raw));
  } catch {
    return {};
  }
}

export function loadArtworkCurationSync(): ArtworkCuration {
  try {
    const raw = fs.readFileSync(curationFilePath(), "utf8");
    return parseArtworkCuration(JSON.parse(raw));
  } catch {
    return {};
  }
}

export async function updateArtworkCurationItem(
  id: string,
  item: ArtworkCurationItem
) {
  const curation = await loadArtworkCuration();
  const nextItem = normalizeCurationItem({
    ...curation[id],
    ...item,
  });

  if (nextItem.highlighted || nextItem.rating) {
    curation[id] = nextItem;
  } else {
    delete curation[id];
  }

  await writeArtworkCuration(curation);
  return curation;
}

function parseArtworkCuration(value: unknown): ArtworkCuration {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};

  const entries = Object.entries(value).flatMap(([id, item]) => {
    const normalized = normalizeCurationItem(item);
    return normalized.highlighted || normalized.rating
      ? [[id, normalized] as const]
      : [];
  });

  return Object.fromEntries(entries);
}

function normalizeCurationItem(value: unknown): ArtworkCurationItem {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};

  const candidate = value as ArtworkCurationItem;
  const item: ArtworkCurationItem = {};

  if (candidate.highlighted === true) item.highlighted = true;

  const rating = Number(candidate.rating);
  if (Number.isInteger(rating) && rating >= 1 && rating <= 5) {
    item.rating = rating as ArtworkCurationItem["rating"];
  }

  return item;
}

async function writeArtworkCuration(curation: ArtworkCuration) {
  const filePath = curationFilePath();
  const tmpPath = `${filePath}.tmp`;
  const body = `${JSON.stringify(curation, null, 2)}\n`;

  await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
  await fsPromises.writeFile(tmpPath, body, "utf8");
  await fsPromises.rename(tmpPath, filePath);
}
