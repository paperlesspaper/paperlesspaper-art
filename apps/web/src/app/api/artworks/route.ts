import { NextResponse } from "next/server";
import {
  corsHeaders,
  isAuthorized,
  parseArtworkSearchParams,
  searchArtworkCatalog,
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
  const result = await searchArtworkCatalog(
    parseArtworkSearchParams(url.searchParams)
  );

  return NextResponse.json(result, { headers });
}
