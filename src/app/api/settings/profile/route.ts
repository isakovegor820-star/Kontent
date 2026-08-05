import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";
import type { PoolClient } from "pg";

import { normalizeBrief } from "@/lib/brief";
import { getPool } from "@/lib/db";
import {
  parseProfileUpdate,
  profileReauthMethod,
} from "@/lib/profile";
import { profileUpdateFingerprint } from "@/lib/profile-server";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";

const noStore = { "Cache-Control": "no-store" };

function response(requestId: string, body: Record<string, unknown>, status = 200) {
  return NextResponse.json({ ...body, requestId }, { status, headers: noStore });
}

function safeError(error: unknown) {
  return {
    errorName: error instanceof Error ? error.name : "Error",
    code: typeof (error as { code?: unknown })?.code === "string"
      ? String((error as { code: string }).code).slice(0, 40)
      : "profile_unavailable",
  };
}

async function ownedChannelId(
  client: Pick<PoolClient, "query">,
  userId: number,
  wanted: number | null,
): Promise<number | null> {
  const result = wanted
    ? await client.query<{ id: string }>(
        `select id from channels where id = $1 and user_id = $2 and is_active = true`,
        [wanted, userId],
      )
    : await client.query<{ id: string }>(
        `select id from channels where user_id = $1 and is_active = true order by id limit 1`,
        [userId],
      );
  return result.rows[0] ? Number(result.rows[0].id) : null;
}

export async function GET(req: NextRequest) {
  const requestId = randomUUID();
  const user = await getSessionUser(req);
  if (!user) return response(requestId, { ok: false, error: "unauthorized" }, 401);

  try {
    const pool = getPool();
    const account = (
      await pool.query<{
        name: string | null;
        avatar: string | null;
        email: string | null;
        password_hash: string | null;
        tg_id: string | null;
        vk_id: string | null;
      }>(
        `select name, avatar, email, password_hash, tg_id, vk_id from users where id = $1`,
        [user.id],
      )
    ).rows[0];
    if (!account) return response(requestId, { ok: false, error: "unauthorized" }, 401);

    const wanted = Number(req.nextUrl.searchParams.get("channel"));
    const channelId = await ownedChannelId(pool as Pick<PoolClient, "query">, user.id, Number.isSafeInteger(wanted) && wanted > 0 ? wanted : null);
    const briefRow = channelId
      ? (
          await pool.query(
            `select niche, audience, rubrics, formats, author_role, goal, cta, taboo, profile_answers,
                    quality, ready, source
               from content_brief
              where user_id = $1 and channel_id = $2`,
            [user.id, channelId],
          )
        ).rows[0]
      : null;
    const pendingEmail = (
      await pool.query<{ target_email: string; expires_at: Date | string }>(
        `select target_email, expires_at
           from email_change_requests
          where user_id = $1 and confirmed_at is null and cancelled_at is null
            and expires_at > now()
          order by generation desc limit 1`,
        [user.id],
      )
    ).rows[0];

    return response(requestId, {
      ok: true,
      account: {
        name: account.name ?? "",
        avatar: account.avatar ?? "",
        email: account.email ?? "",
        reauthMethod: profileReauthMethod(account),
      },
      pendingEmail: pendingEmail
        ? { email: pendingEmail.target_email, expiresAt: new Date(pendingEmail.expires_at).toISOString() }
        : null,
      channelId,
      brief: channelId ? normalizeBrief(briefRow ?? {}) : null,
    });
  } catch (error) {
    console.error("[/api/settings/profile] GET", { requestId, ...safeError(error) });
    return response(requestId, { ok: false, error: "unavailable" }, 503);
  }
}

export async function POST(req: NextRequest) {
  const requestId = randomUUID();
  if (!hasTrustedMutationOrigin(req)) {
    return response(requestId, { ok: false, error: "forbidden_origin" }, 403);
  }
  const user = await getSessionUser(req);
  if (!user) return response(requestId, { ok: false, error: "unauthorized" }, 401);

  const parsed = parseProfileUpdate(
    await req.json().catch(() => null),
    req.headers.get("idempotency-key"),
  );
  if (!parsed.ok) return response(requestId, { ok: false, error: parsed.error }, 422);

  const input = parsed.value;
  const fingerprint = profileUpdateFingerprint({
    channelId: input.channelId,
    name: input.name,
    avatar: input.avatar,
    brief: input.brief,
  });
  let client: PoolClient;
  try {
    client = await getPool().connect();
  } catch (error) {
    console.error("[/api/settings/profile] connect", { requestId, ...safeError(error) });
    return response(requestId, { ok: false, error: "unavailable" }, 503);
  }

  try {
    await client.query("begin");
    await client.query(`select pg_advisory_xact_lock($1::bigint)`, [user.id]);
    const previous = (
      await client.query<{ request_fingerprint: string; result_payload: Record<string, unknown> }>(
        `select request_fingerprint, result_payload
           from profile_update_operations
          where user_id = $1 and request_key = $2`,
        [user.id, input.requestKey],
      )
    ).rows[0];
    if (previous) {
      await client.query("rollback");
      if (previous.request_fingerprint !== fingerprint) {
        return response(requestId, { ok: false, error: "idempotency_conflict" }, 409);
      }
      return response(requestId, { ...previous.result_payload, replayed: true });
    }

    if (!(await ownedChannelId(client, user.id, input.channelId))) {
      await client.query("rollback");
      return response(requestId, { ok: false, error: "channel_not_found" }, 404);
    }

    const account = (
      await client.query<{ email: string | null }>(
        `update users set name = $2, avatar = nullif($3, '') where id = $1 returning email`,
        [user.id, input.name, input.avatar],
      )
    ).rows[0];
    await client.query(
      `insert into content_brief
         (user_id, channel_id, niche, audience, rubrics, formats, author_role,
          goal, cta, taboo, ready, source, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true, 'manual', now())
       on conflict (user_id, channel_id) do update
         set niche = excluded.niche,
             audience = excluded.audience,
             rubrics = excluded.rubrics,
             formats = excluded.formats,
             author_role = excluded.author_role,
             goal = excluded.goal,
             cta = excluded.cta,
             taboo = excluded.taboo,
             ready = true,
             source = 'manual',
             updated_at = now()`,
      [
        user.id,
        input.channelId,
        input.brief.niche,
        input.brief.audience,
        input.brief.rubrics,
        input.brief.formats,
        input.brief.authorRole,
        input.brief.goal,
        input.brief.cta,
        input.brief.taboo,
      ],
    );

    const payload = {
      ok: true,
      account: { name: input.name, avatar: input.avatar, email: account?.email ?? "" },
      channelId: input.channelId,
      brief: { ...input.brief, ready: true, source: "manual" },
    };
    await client.query(
      `insert into profile_update_operations
         (user_id, request_key, request_fingerprint, result_payload)
       values ($1, $2, $3, $4::jsonb)`,
      [user.id, input.requestKey, fingerprint, JSON.stringify(payload)],
    );
    await client.query("commit");
    return response(requestId, payload);
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    console.error("[/api/settings/profile] POST", { requestId, ...safeError(error) });
    return response(requestId, { ok: false, error: "unavailable" }, 503);
  } finally {
    client.release();
  }
}
