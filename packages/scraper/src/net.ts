import fs from "node:fs/promises";

export class HttpError extends Error {
  readonly status: number;
  readonly statusText: string;
  readonly url: string;

  constructor(params: { status: number; statusText: string; url: string }) {
    super(`HTTP ${params.status} ${params.statusText} for ${params.url}`);
    this.name = "HttpError";
    this.status = params.status;
    this.statusText = params.statusText;
    this.url = params.url;
  }
}

export async function downloadToFile(
  url: string,
  outPath: string,
  extraHeaders: Record<string, string> = {}
) {
  const res = await fetch(url, {
    redirect: "follow",
    headers: {
      "User-Agent": "paperlesspaper-art/0.1 (+local)",
      ...extraHeaders,
    },
  });
  if (!res.ok) {
    throw new HttpError({ status: res.status, statusText: res.statusText, url });
  }

  const arrayBuffer = await res.arrayBuffer();
  await fs.writeFile(outPath, new Uint8Array(arrayBuffer));

  const contentType = res.headers.get("content-type") ?? undefined;
  return { contentType, bytes: arrayBuffer.byteLength };
}
