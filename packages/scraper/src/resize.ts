import sharp from "sharp";

export async function resizeToJpegs(params: {
  inputPath: string;
  outputPathsByWidth: Record<number, string>;
}) {
  const input = sharp(params.inputPath, { failOn: "none" });

  await Promise.all(
    Object.entries(params.outputPathsByWidth).map(async ([w, outPath]) => {
      const width = Number(w);
      await input
        .clone()
        .resize({ width, withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toFile(outPath);
    })
  );
}
