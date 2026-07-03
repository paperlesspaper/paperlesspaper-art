import { NextResponse } from "next/server";
import {
  getScraperPreviewImage,
  getScraperStatus,
  submitPreviewDecision,
  startScraper,
  stopScraper,
} from "@/lib/scraper-control";
import { isAuthorized } from "@/lib/artworks";
import { isLocalDevelopmentRequest } from "@/lib/local-dev";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
};

export async function GET(request: Request) {
  const guardResponse = guardLocalScraperAccess(request);
  if (guardResponse) return guardResponse;

  const url = new URL(request.url);
  const previewImageId = url.searchParams.get("previewImage");
  if (previewImageId) {
    return getScraperPreviewImage(previewImageId);
  }

  return NextResponse.json(
    await getScraperStatus({
      keywords: url.searchParams.get("keywords") ?? undefined,
    }),
    { headers: NO_STORE_HEADERS }
  );
}

export async function POST(request: Request) {
  const guardResponse = guardLocalScraperAccess(request);
  if (guardResponse) return guardResponse;

  const body = await request.json().catch(() => undefined);
  const action =
    body && typeof body === "object" && !Array.isArray(body) && "action" in body
      ? body.action
      : undefined;

  try {
    if (action === "start") {
      return NextResponse.json(await startScraper(body), {
        headers: NO_STORE_HEADERS,
      });
    }

    if (action === "stop") {
      return NextResponse.json(await stopScraper(), {
        headers: NO_STORE_HEADERS,
      });
    }

    if (action === "previewDecision") {
      return NextResponse.json(await submitPreviewDecision(body), {
        headers: NO_STORE_HEADERS,
      });
    }

    return NextResponse.json(
      { error: "Unknown scraper action" },
      { status: 400, headers: NO_STORE_HEADERS }
    );
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Scraper request failed",
      },
      { status: 400, headers: NO_STORE_HEADERS }
    );
  }
}

function guardLocalScraperAccess(request: Request) {
  if (!isLocalDevelopmentRequest(request)) {
    return NextResponse.json(
      { error: "Scraper controls are only available in local development" },
      { status: 403, headers: NO_STORE_HEADERS }
    );
  }

  if (!isAuthorized(request)) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401, headers: NO_STORE_HEADERS }
    );
  }

  return undefined;
}
