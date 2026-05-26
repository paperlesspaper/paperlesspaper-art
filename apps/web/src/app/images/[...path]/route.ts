import { NextResponse } from "next/server";
import { corsHeaders } from "@/lib/artworks";

export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{
    path: string[];
  }>;
};

export async function GET(request: Request, context: RouteContext) {
  return redirectToAsset(request, context);
}

export async function HEAD(request: Request, context: RouteContext) {
  return redirectToAsset(request, context);
}

export async function OPTIONS(request: Request) {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(request),
  });
}

async function redirectToAsset(request: Request, context: RouteContext) {
  const headers = {
    ...corsHeaders(request),
    "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
  };
  const assetBaseUrl = process.env.ART_ASSET_BASE_URL?.trim();

  if (!assetBaseUrl) {
    return NextResponse.json(
      { error: "ART_ASSET_BASE_URL is not configured" },
      { status: 404, headers }
    );
  }

  const { path } = await context.params;
  const assetPath = path.map(encodeURIComponent).join("/");
  const targetUrl = new URL(
    `images/${assetPath}`,
    `${assetBaseUrl.replace(/\/+$/, "")}/`
  );
  const sourceUrl = new URL(request.url);

  targetUrl.search = sourceUrl.search;

  if (targetUrl.origin === sourceUrl.origin) {
    return NextResponse.json(
      { error: "ART_ASSET_BASE_URL points back to this app" },
      { status: 500, headers }
    );
  }

  return NextResponse.redirect(targetUrl, {
    status: 307,
    headers,
  });
}
