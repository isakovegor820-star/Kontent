import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";

export const runtime = "nodejs";

/** Older clients must return to the draft workflow to obtain an exact approval. */
export async function POST(req: NextRequest) {
  if (!hasTrustedMutationOrigin(req)) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  if (!await getSessionUser(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json({
    ok: false,
    error: "publication_operation_required",
    message: "Откройте черновик и добавьте согласованную версию в календарь.",
    replacement: "/api/publication-operations",
  }, { status: 410 });
}
