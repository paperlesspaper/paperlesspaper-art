import { NextResponse } from "next/server";
import { corsHeaders } from "@/lib/artworks";

export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{
    path: string[];
  }>;
};

export async function GET(request: Request, context: RouteContext) {
  return proxyAsset(request, context);
}

export async function HEAD(request: Request, context: RouteContext) {
  return proxyAsset(request, context);
}

export async function OPTIONS(request: Request) {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(request),
  });
}

async function proxyAsset(request: Request, context: RouteContext) {
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

  const upstreamHeaders = new Headers();
  copyRequestHeader(request, upstreamHeaders, "range");
  copyRequestHeader(request, upstreamHeaders, "if-none-match");
  copyRequestHeader(request, upstreamHeaders, "if-modified-since");

  const upstreamResponse = await fetch(targetUrl, {
    method: request.method,
    headers: upstreamHeaders,
    redirect: "follow",
  });

  const responseHeaders = new Headers(headers);
  copyResponseHeader(upstreamResponse, responseHeaders, "accept-ranges");
  copyResponseHeader(upstreamResponse, responseHeaders, "content-disposition");
  copyResponseHeader(upstreamResponse, responseHeaders, "content-length");
  copyResponseHeader(upstreamResponse, responseHeaders, "content-range");
  copyResponseHeader(upstreamResponse, responseHeaders, "content-type");
  copyResponseHeader(upstreamResponse, responseHeaders, "etag");
  copyResponseHeader(upstreamResponse, responseHeaders, "last-modified");

  return new Response(
    request.method === "HEAD" ? null : upstreamResponse.body,
    {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: responseHeaders,
    }
  );
}

function copyRequestHeader(
  request: Request,
  targetHeaders: Headers,
  headerName: string
) {
  const value = request.headers.get(headerName);
  if (value) targetHeaders.set(headerName, value);
}

function copyResponseHeader(
  response: Response,
  targetHeaders: Headers,
  headerName: string
) {
  const value = response.headers.get(headerName);
  if (value) targetHeaders.set(headerName, value);
}
