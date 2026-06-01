import { ensureArtworkDatabase, getArtworkPool } from "@/lib/artwork-database";

export type ArtworkCurationItem = {
  highlighted?: boolean;
  rating?: 1 | 2 | 3 | 4 | 5;
};

export type ArtworkCuration = Record<string, ArtworkCurationItem>;

export async function loadArtworkCuration(): Promise<ArtworkCuration> {
  await ensureArtworkDatabase();

  const result = await getArtworkPool().query<{
    id: string;
    highlighted: boolean;
    rating: number | null;
  }>(
    `SELECT id, highlighted, rating
     FROM artwork_curation
     WHERE highlighted = TRUE OR rating IS NOT NULL
     ORDER BY id`
  );

  return Object.fromEntries(
    result.rows.flatMap((row) => {
      const item = normalizeCurationItem(row);
      return item.highlighted || item.rating ? [[row.id, item] as const] : [];
    })
  );
}

export async function updateArtworkCurationItem(
  id: string,
  item: ArtworkCurationItem
) {
  await ensureArtworkDatabase();

  const current = await getArtworkPool().query<{
    highlighted: boolean;
    rating: number | null;
  }>(
    `SELECT highlighted, rating
     FROM artwork_curation
     WHERE id = $1
     LIMIT 1`,
    [id]
  );
  const nextItem = normalizeCurationItem({
    ...current.rows[0],
    ...item,
  });

  if (nextItem.highlighted || nextItem.rating) {
    await getArtworkPool().query(
      `INSERT INTO artwork_curation (id, highlighted, rating)
       VALUES ($1, $2, $3)
       ON CONFLICT (id)
       DO UPDATE SET highlighted = EXCLUDED.highlighted, rating = EXCLUDED.rating`,
      [id, nextItem.highlighted === true, nextItem.rating ?? null]
    );
  } else {
    await getArtworkPool().query("DELETE FROM artwork_curation WHERE id = $1", [
      id,
    ]);
  }

  return nextItem;
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
