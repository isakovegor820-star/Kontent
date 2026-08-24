import { readJsonBodyValue } from "@/lib/bounded-request-body";
import { NextRequest, NextResponse } from "next/server";

import { getPool } from "@/lib/db";
import { LIBRARY_EXPORT_FORMATS } from "@/lib/library-export.mjs";
import { parseLibraryFilters } from "@/lib/library-filters";
import { buildLibraryRegistrySnapshot } from "@/lib/library-registry";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";

const REQUEST_KEY = /^[A-Za-z0-9][A-Za-z0-9:_-]{15,95}$/u;

export async function POST(req: NextRequest) {
  if (!hasTrustedMutationOrigin(req)) {
    return NextResponse.json({ ok: false, error: "forbidden_origin" }, { status: 403 });
  }
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const requestKey = req.headers.get("idempotency-key")?.trim() ?? "";
  if (!REQUEST_KEY.test(requestKey)) {
    return NextResponse.json({ ok: false, error: "bad_idempotency_key" }, { status: 400 });
  }
  let body: { filters?: Record<string, unknown> };
  try {
    body = await readJsonBodyValue(req);
  } catch {
    return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  }
  try {
    const snapshot = await buildLibraryRegistrySnapshot(
      user.id,
      parseLibraryFilters(body.filters ?? {}),
    );
    if (!snapshot) return NextResponse.json({ ok: false, error: "no_channel" }, { status: 422 });
    const inserted = await getPool().query<{ id: string }>(
      `insert into library_export_snapshots
         (user_id, channel_id, request_key, formula_version, snapshot)
       values ($1, $2, $3, $4, $5::jsonb)
       on conflict (user_id, request_key) do nothing
       returning id`,
      [user.id, snapshot.channelId, requestKey, snapshot.formulaVersion, JSON.stringify(snapshot)],
    );
    const replay = !inserted.rows[0];
    const stored = inserted.rows[0] ?? (
      await getPool().query<{ id: string }>(
        `select id from library_export_snapshots
          where user_id = $1 and request_key = $2 and expires_at > now()`,
        [user.id, requestKey],
      )
    ).rows[0];
    if (!stored) return NextResponse.json({ ok: false, error: "snapshot_expired" }, { status: 410 });
    const id = Number(stored.id);
    return NextResponse.json(
      {
        ok: true,
        id,
        replay,
        formulaVersion: snapshot.formulaVersion,
        count: snapshot.items.length,
        formats: LIBRARY_EXPORT_FORMATS.map((format) => ({
          format,
          href: `/api/library/exports/${id}?format=${format}`,
        })),
      },
      { status: replay ? 200 : 201 },
    );
  } catch (error) {
    console.error("[/api/library/exports] POST", { errorName: error instanceof Error ? error.name : "Error" });
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}
