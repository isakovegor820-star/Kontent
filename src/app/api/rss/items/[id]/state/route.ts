import { NextRequest, NextResponse } from "next/server";

import { getPool } from "@/lib/db";
import { ProjectAccessError, requireSelectedProjectPermission } from "@/lib/project-permissions";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };
type OpportunityState = "saved" | "dismissed" | "used";

export async function POST(req: NextRequest, { params }: Context) {
  if (!hasTrustedMutationOrigin(req)) {
    return NextResponse.json({ ok: false, error: "forbidden_origin" }, { status: 403 });
  }
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const itemId = Number((await params).id);
  if (!Number.isSafeInteger(itemId) || itemId <= 0) {
    return NextResponse.json({ ok: false, error: "bad_item" }, { status: 400 });
  }
  const body = await req.json().catch(() => null) as { state?: unknown; viewed?: unknown } | null;
  const hasState = body != null && Object.prototype.hasOwnProperty.call(body, "state");
  const state = body?.state;
  const viewed = body?.viewed === true;
  if (!hasState && !viewed) {
    return NextResponse.json({ ok: false, error: "empty_state" }, { status: 422 });
  }
  if (hasState && state !== "saved" && state !== "dismissed" && state !== "used" && state !== null) {
    return NextResponse.json({ ok: false, error: "bad_state" }, { status: 422 });
  }

  try {
    const pool = getPool();
    const membership = await requireSelectedProjectPermission(pool, user.id, "project.read");
    const owned = await pool.query(
      `select i.id
         from rss_items i
         join rss_feeds f on f.id = i.feed_id
         join channels c on c.id = f.channel_id
        where i.id = $1
          and f.user_id = $2
          and f.source_kind = 'legal_opportunity'
          and c.project_id = $3`,
      [itemId, user.id, membership.projectId],
    );
    if (!owned.rowCount) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });

    if (hasState) {
      if (state === null) {
        await pool.query(
          `delete from legal_opportunity_states where user_id = $1 and rss_item_id = $2`,
          [user.id, itemId],
        );
      } else {
        await pool.query(
          `insert into legal_opportunity_states (user_id, rss_item_id, state, updated_at)
           values ($1, $2, $3, now())
           on conflict (user_id, rss_item_id) do update set
             state = excluded.state,
             updated_at = now()`,
          [user.id, itemId, state as OpportunityState],
        );
      }
    }

    const read = await pool.query<{ read_at: Date | string }>(
      `insert into legal_opportunity_reads (user_id, project_id, rss_item_id, read_at)
       values ($1, $2, $3, now())
       on conflict (user_id, project_id, rss_item_id) do update set
         read_at = legal_opportunity_reads.read_at
       returning read_at`,
      [user.id, membership.projectId, itemId],
    );

    return NextResponse.json({
      ok: true,
      ...(hasState ? { state } : {}),
      readAt: new Date(read.rows[0]?.read_at ?? Date.now()).toISOString(),
    });
  } catch (error) {
    if (error instanceof ProjectAccessError) {
      return NextResponse.json({ ok: false, error: "access_denied" }, { status: 403 });
    }
    console.error("[/api/rss/items/:id/state] POST", {
      errorName: error instanceof Error ? error.name : "Error",
    });
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}
