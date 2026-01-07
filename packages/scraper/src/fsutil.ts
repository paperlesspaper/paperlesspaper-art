import fs from "node:fs/promises";
import path from "node:path";

export async function ensureDir(dirPath: string) {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function fileExists(filePath: string) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function writeJsonAtomic(filePath: string, value: unknown) {
  const dir = path.dirname(filePath);
  await ensureDir(dir);

  const tmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.tmp`
  );
  await fs.writeFile(tmpPath, JSON.stringify(value, null, 2) + "\n", "utf8");
  await fs.rename(tmpPath, filePath);
}

export async function readJsonFile<T>(
  filePath: string,
  fallback: T
): Promise<T> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
