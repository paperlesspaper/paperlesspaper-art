import fs from "node:fs/promises";

const DEFAULT_USER_AGENT =
  "paperlesspaper-art/0.1 (https://github.com/paperlesspaper/paperlesspaper-art)";
const DEFAULT_RETRY_ATTEMPTS = 4;
const DEFAULT_RETRY_BASE_DELAY_MS = 5_000;
const DEFAULT_RETRY_MAX_DELAY_MS = 120_000;
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;
const RETRYABLE_STATUSES = new Set([429, 503]);

export class HttpError extends Error {
  readonly status: number;
  readonly statusText: string;
  readonly url: string;
  readonly retryAfterMs: number | undefined;

  constructor(params: {
    status: number;
    statusText: string;
    url: string;
    retryAfterMs?: number;
  }) {
    super(`HTTP ${params.status} ${params.statusText} for ${params.url}`);
    this.name = "HttpError";
    this.status = params.status;
    this.statusText = params.statusText;
    this.url = params.url;
    this.retryAfterMs = params.retryAfterMs;
  }
}

export async function fetchWithBackoff(
  url: string | URL,
  init: RequestInit = {},
  options: {
    attempts?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    timeoutMs?: number;
  } = {}
) {
  const attempts = options.attempts ?? DEFAULT_RETRY_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const urlText = String(url);

  for (let attempt = 1; attempt <= attempts; attempt++) {
    let res: Response;

    try {
      res = await fetch(url, {
        ...init,
        signal: init.signal ?? AbortSignal.timeout(timeoutMs),
        headers: withDefaultHeaders(init.headers),
      });
    } catch (error) {
      if (attempt === attempts) throw error;

      const delayMs = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      console.warn(
        `${errorName(error)} for ${urlText}; retrying in ${Math.ceil(
          delayMs / 1000
        )}s (${attempt}/${attempts})`
      );
      await sleep(delayMs);
      continue;
    }

    if (!RETRYABLE_STATUSES.has(res.status) || attempt === attempts) {
      return res;
    }

    const retryAfterMs = parseRetryAfterMs(res.headers);
    const exponentialDelayMs = baseDelayMs * 2 ** (attempt - 1);
    const delayMs = Math.min(
      retryAfterMs ?? exponentialDelayMs,
      maxDelayMs
    );

    console.warn(
      `HTTP ${res.status} for ${urlText}; retrying in ${Math.ceil(
        delayMs / 1000
      )}s (${attempt}/${attempts})`
    );
    await sleep(delayMs);
  }

  throw new Error("fetchWithBackoff exhausted without returning a response");
}

function errorName(error: unknown) {
  return error instanceof Error ? error.name || error.message : String(error);
}

export async function downloadToFile(
  url: string,
  outPath: string,
  extraHeaders: Record<string, string> = {}
) {
  const res = await fetchWithBackoff(url, {
    redirect: "follow",
    headers: extraHeaders,
  });
  if (!res.ok) {
    throw new HttpError({
      status: res.status,
      statusText: res.statusText,
      url,
      retryAfterMs: parseRetryAfterMs(res.headers),
    });
  }

  const arrayBuffer = await res.arrayBuffer();
  await fs.writeFile(outPath, new Uint8Array(arrayBuffer));

  const contentType = res.headers.get("content-type") ?? undefined;
  return { contentType, bytes: arrayBuffer.byteLength };
}

function withDefaultHeaders(headers: HeadersInit | undefined) {
  const merged = new Headers(headers);
  if (!merged.has("User-Agent")) {
    merged.set(
      "User-Agent",
      process.env.WIKIMEDIA_USER_AGENT?.trim() || DEFAULT_USER_AGENT
    );
  }

  return merged;
}

export function parseRetryAfterMs(headers: Headers) {
  const retryAfter = headers.get("retry-after");
  if (!retryAfter) return undefined;

  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const dateMs = Date.parse(retryAfter);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }

  return undefined;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
