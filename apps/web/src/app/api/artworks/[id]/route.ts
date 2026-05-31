import { NextResponse } from "next/server";
import {
  corsHeaders,
  findArtworkInCatalogById,
  isAuthorized,
} from "@/lib/artworks";

export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

export async function OPTIONS(request: Request) {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(request),
  });
}

export async function GET(request: Request, context: RouteContext) {
  const headers = corsHeaders(request);

  if (!isAuthorized(request)) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401, headers }
    );
  }

  const { id } = await context.params;
  const artwork = await findArtworkInCatalogById(decodeURIComponent(id));

  if (!artwork) {
    return NextResponse.json({ error: "Not found" }, { status: 404, headers });
  }

  return NextResponse.json({ item: artwork }, { headers });
}
