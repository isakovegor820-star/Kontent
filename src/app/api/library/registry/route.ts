import { NextRequest, NextResponse } from "next/server";

import { parseLibraryFilters } from "@/lib/library-filters";
import { buildLibraryRegistrySnapshot } from "@/lib/library-registry";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  try {
    const snapshot = await buildLibraryRegistrySnapshot(user.id, parseLibraryFilters(req.nextUrl.searchParams));
    if (!snapshot) return NextResponse.json({ ok: false, error: "no_channel" }, { status: 422 });
    return NextResponse.json({ ok: true, ...snapshot });
  } catch (error) {
    console.error("[/api/library/registry] GET", { errorName: error instanceof Error ? error.name : "Error" });
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}
