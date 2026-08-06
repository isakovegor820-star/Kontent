import { NextRequest, NextResponse } from "next/server";
import type { PoolClient } from "pg";

import { getPool } from "@/lib/db";
import { normalizeIdempotencyKey } from "@/lib/publication-idempotency";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";

export async function DELETE(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  if (!hasTrustedMutationOrigin(req)) {
    return NextResponse.json({ ok: false, error: "forbidden_origin" }, { status: 403 });
  }
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const channelId = Number((await context.params).id);
  if (!Number.isSafeInteger(channelId) || channelId <= 0) {
    return NextResponse.json({ ok: false, error: "bad_channel" }, { status: 422 });
  }
  const idempotencyKey = normalizeIdempotencyKey(req.headers.get("idempotency-key"));
  if (!idempotencyKey) {
    return NextResponse.json({ ok: false, error: "idempotency_key_required" }, { status: 400 });
  }

  const pool = getPool();
  let client: PoolClient | null = null;
  try {
    client = await pool.connect();
    await client.query("begin");
    const channel = (await client.query<{
      id: string;
      status: string;
      oauth_token_id: string | null;
    }>(
      `select id, status, oauth_token_id from channels
        where id = $1 and user_id = $2 for update`,
      [channelId, user.id],
    )).rows[0];
    if (!channel) {
      await client.query("rollback");
      return NextResponse.json({ ok: false, error: "channel_not_found" }, { status: 404 });
    }
    const replay = (await client.query(
      `select 1 from channel_events
        where channel_id = $1 and request_id = $2 and action = 'disconnected'`,
      [channelId, idempotencyKey],
    )).rowCount;
    if (replay || channel.status === "disconnected") {
      await client.query("commit");
      return NextResponse.json({ ok: true, status: "disconnected", replayed: true });
    }
    const pending = await client.query<{
      id: string;
      status: string;
      publication_operation_id: string | null;
    }>(
      `select id, status, publication_operation_id
         from posts
        where channel_id = $1 and status in ('scheduled','failed_retry','publishing')
        order by id for update`,
      [channelId],
    );
    if (pending.rows.some((post) => post.status === "publishing")) {
      await client.query("rollback");
      return NextResponse.json({ ok: false, error: "publication_in_progress" }, { status: 409 });
    }
    if (pending.rows.length > 0) {
      await client.query("rollback");
      return NextResponse.json({
        ok: false,
        error: "scheduled_publications_require_resolution",
        scheduledCount: pending.rows.length,
        operationIds: [...new Set(pending.rows
          .map((post) => Number(post.publication_operation_id))
          .filter((id) => Number.isSafeInteger(id) && id > 0))],
      }, { status: 409 });
    }
    if (channel.oauth_token_id) {
      await client.query(
        `update oauth_tokens
            set is_active = false, access_token = 'revoked', refresh_token = null,
                expires_at = null, updated_at = now()
          where id = $1`,
        [channel.oauth_token_id],
      );
    }
    await client.query(
      `update channels
          set status = 'disconnected', is_active = false, vk_token = null,
              oauth_token_id = null, disconnected_at = now(), updated_at = now()
        where id = $1`,
      [channelId],
    );
    await client.query(
      `update autopilot_settings set enabled = false, updated_at = now()
        where channel_id = $1`,
      [channelId],
    );
    await client.query(
      `insert into channel_events
         (channel_id, actor_user_id, action, from_status, to_status, request_id)
       values ($1, $2, 'disconnected', $3, 'disconnected', $4)`,
      [channelId, user.id, channel.status, idempotencyKey],
    );
    await client.query("commit");
    return NextResponse.json({ ok: true, status: "disconnected", replayed: false });
  } catch (error) {
    await client?.query("rollback").catch(() => {});
    console.error("[/api/channels/:id] DELETE", {
      errorName: error instanceof Error ? error.name : "Error",
      channelId,
    });
    return NextResponse.json({ ok: false, error: "channel_disconnect_failed" }, { status: 503 });
  } finally {
    client?.release();
  }
}
