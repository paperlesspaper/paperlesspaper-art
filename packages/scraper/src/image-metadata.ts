import sharp from "sharp";

export async function getImageDimensions(filePath: string) {
  const metadata = await sharp(filePath, { failOn: "none" }).metadata();
  const { width, height } = metadata;

  if (!isPositiveFiniteNumber(width) || !isPositiveFiniteNumber(height)) {
    return undefined;
  }

  return { width, height };
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value > 0
  );
}
