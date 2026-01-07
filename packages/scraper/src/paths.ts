import fs from "node:fs/promises";
import path from "node:path";

async function exists(p: string) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function findWebRoot(startDir: string) {
  let dir = path.resolve(startDir);

  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, "apps", "web", "package.json");
    if (await exists(candidate)) {
      return path.join(dir, "apps", "web");
    }

    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return null;
}

export function parseWidths(value: string) {
  const parts = value
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => Number(x));

  const widths = parts.filter((n) => Number.isFinite(n) && n > 0);
  if (widths.length === 0) return [512, 1024];

  return [...new Set(widths)].sort((a, b) => a - b);
}

export function safeSegment(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}
