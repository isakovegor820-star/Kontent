import { NextRequest, NextResponse } from "next/server";

import { getPool } from "@/lib/db";
import {
  LIBRARY_EXPORT_FORMATS,
  renderLibraryExport,
  type LibraryExportSnapshot,
} from "@/lib/library-export.mjs";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, context: Context) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const id = Number((await context.params).id);
  const format = req.nextUrl.searchParams.get("format") ?? "";
  if (!Number.isSafeInteger(id) || id <= 0 || !LIBRARY_EXPORT_FORMATS.includes(format as never)) {
    return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  }
  try {
    const row = await getPool().query<{ snapshot: LibraryExportSnapshot }>(
      `select snapshot from library_export_snapshots
        where id = $1 and user_id = $2 and expires_at > now()`,
      [id, user.id],
    );
    if (!row.rows[0]) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
    const rendered = await renderLibraryExport(format, row.rows[0].snapshot);
    const filename = `aurora-ideas-${id}.${rendered.extension}`;
    return new NextResponse(new Uint8Array(rendered.bytes), {
      status: 200,
      headers: {
        "content-type": rendered.contentType,
        "content-disposition": `attachment; filename="${filename}"`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    console.error("[/api/library/exports/:id] GET", { errorName: error instanceof Error ? error.name : "Error" });
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}
