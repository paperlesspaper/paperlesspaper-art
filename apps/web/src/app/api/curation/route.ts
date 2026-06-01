import { NextResponse } from "next/server";
import {
  loadArtworkCuration,
  updateArtworkCurationItem,
  type ArtworkCurationItem,
} from "@/lib/artwork-curation";
import { isAuthorized } from "@/lib/artworks";
import { isLocalDevelopmentRequest } from "@/lib/local-dev";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return NextResponse.json({ curation: await loadArtworkCuration() });
}

export async function PATCH(request: Request) {
  if (!isLocalDevelopmentRequest(request)) {
    return NextResponse.json(
      { error: "Curation updates are only available in local development" },
      { status: 403 }
    );
  }

  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => undefined);

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const id = "id" in body && typeof body.id === "string" ? body.id : "";
  if (!id) {
    return NextResponse.json({ error: "Missing artwork id" }, { status: 400 });
  }

  const item: ArtworkCurationItem = {};

  if ("highlighted" in body) {
    item.highlighted = body.highlighted === true;
  }

  if ("rating" in body) {
    const rating = Number(body.rating);
    if (Number.isInteger(rating) && rating >= 1 && rating <= 5) {
      item.rating = rating as ArtworkCurationItem["rating"];
    } else if (body.rating === null || body.rating === undefined) {
      item.rating = undefined;
    } else {
      return NextResponse.json(
        { error: "Rating must be an integer from 1 to 5" },
        { status: 400 }
      );
    }
  }

  return NextResponse.json({
    curation: await updateArtworkCurationItem(id, item),
  });
}
