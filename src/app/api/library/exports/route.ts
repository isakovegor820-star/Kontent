import { projectNativeUrl } from "@/lib/project-native-url";
import { ProjectAccessError, requireSelectedProjectPermission, requireProjectPermission } from "@/lib/project-permissions";
import { readJsonBodyValue } from "@/lib/bounded-request-body";
import { NextRequest, NextResponse } from "next/server";

import { getPool } from "@/lib/db";
import { LIBRARY_EXPORT_FORMATS } from "@/lib/library-export.mjs";
import { parseLibraryFilters } from "@/lib/library-filters";
import { buildLibraryRegistrySnapshot } from "@/lib/library-registry";
import type { LibraryRegistrySnapshot } from "@/lib/library-registry";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";

const REQUEST_KEY = /^[A-Za-z0-9][A-Za-z0-9:_-]{15,95}$/u;

type StoredExportSnapshot = {
  id: string;
  snapshot: LibraryRegistrySnapshot;
};

function exportResponse(stored: StoredExportSnapshot, replay: boolean, projectId: number) {
  const id = Number(stored.id);
  return NextResponse.json(
    {
      ok: true,
      id,
      replay,
      formulaVersion: stored.snapshot.formulaVersion,
      count: stored.snapshot.items.length,
      formats: LIBRARY_EXPORT_FORMATS.map((format) => ({
        format,
        href: projectNativeUrl(`/api/library/exports/${id}?format=${format}`, projectId),
      })),
    },
    { status: replay ? 200 : 201 },
  );
}

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
    const pool = getPool();
    const membership = await requireSelectedProjectPermission(pool, user.id, "project.read");
    const existing = (
      await pool.query<StoredExportSnapshot>(
        `select snapshot_row.id, snapshot_row.snapshot from library_export_snapshots snapshot_row
           join channels channel on channel.id = snapshot_row.channel_id
          where snapshot_row.user_id = $1 and snapshot_row.request_key = $2 and snapshot_row.expires_at > now()
            and channel.project_id = $3`,
        [user.id, requestKey, membership.projectId],
      )
    ).rows[0];
    if (existing) {
      await requireProjectPermission(pool, user.id, membership.projectId, "project.read");
      return exportResponse(existing, true, membership.projectId);
    }

    const snapshot = await buildLibraryRegistrySnapshot(
      user.id,
      parseLibraryFilters(body.filters ?? {}),
    );
    if (!snapshot) return NextResponse.json({ ok: false, error: "no_channel" }, { status: 422 });
    const inserted = await pool.query<StoredExportSnapshot>(
      `insert into library_export_snapshots
         (user_id, channel_id, request_key, formula_version, snapshot)
       select $1, channel.id, $3, $4, $5::jsonb
         from channels channel
         join project_members member on member.project_id = channel.project_id and member.user_id = $1 and member.status = 'active'
         join projects project on project.id = channel.project_id and project.is_archived = false
        where channel.id = $2 and channel.project_id = $6
       on conflict (user_id, request_key) do nothing
       returning id, snapshot`,
      [user.id, snapshot.channelId, requestKey, snapshot.formulaVersion, JSON.stringify(snapshot), membership.projectId],
    );
    const replay = !inserted.rows[0];
    const stored = inserted.rows[0] ?? (
      await pool.query<StoredExportSnapshot>(
        `select snapshot_row.id, snapshot_row.snapshot from library_export_snapshots snapshot_row
           join channels channel on channel.id = snapshot_row.channel_id
          where snapshot_row.user_id = $1 and snapshot_row.request_key = $2 and snapshot_row.expires_at > now()
            and channel.project_id = $3`,
        [user.id, requestKey, membership.projectId],
      )
    ).rows[0];
    if (!stored) return NextResponse.json({ ok: false, error: "snapshot_expired" }, { status: 410 });
    await requireProjectPermission(pool, user.id, membership.projectId, "project.read");
    return exportResponse(stored, replay, membership.projectId);
  } catch (error) {
    if (error instanceof ProjectAccessError) return NextResponse.json({ ok: false, error: "access_denied" }, { status: 403 });
    console.error("[/api/library/exports] POST", { errorName: error instanceof Error ? error.name : "Error" });
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}
