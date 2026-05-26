import { NextResponse } from "next/server";
import { loadArtworkCuration } from "@/lib/artwork-curation";
import {
  corsHeaders,
  isAuthorized,
  loadArtworks,
  parseArtworkSearchParams,
  searchArtworks,
} from "@/lib/artworks";

export const dynamic = "force-dynamic";

export async function OPTIONS(request: Request) {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(request),
  });
}

export async function GET(request: Request) {
  const headers = corsHeaders(request);

  if (!isAuthorized(request)) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401, headers }
    );
  }

  const url = new URL(request.url);
  const [artworks, curation] = await Promise.all([
    loadArtworks(),
    loadArtworkCuration(),
  ]);
  const result = searchArtworks(
    artworks,
    parseArtworkSearchParams(url.searchParams),
    curation
  );

  return NextResponse.json(result, { headers });
}
