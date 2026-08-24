import { readJsonBodyValue } from "@/lib/bounded-request-body";
import { NextRequest, NextResponse } from "next/server";
import { createHash, randomUUID } from "node:crypto";

import { getPool } from "@/lib/db";
import {
  buildMediaPromptContext,
  MEDIA_PROMPT_POLICY,
  validateMediaInput,
} from "@/lib/media-generation.mjs";
import type { MediaGenerationStatus } from "@/lib/media-generation.mjs";
import { reconcileStaleMediaGeneration } from "@/lib/media-generation-reconciliation";
import { navyMediaCapabilities } from "@/lib/navy-media.mjs";
import { enqueueMediaGeneration, hasMediaWorker } from "@/lib/queue";
import { getSessionUser } from "@/lib/session";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import {
  ProjectAccessError,
  requireSelectedProjectPermission,
} from "@/lib/project-permissions";
import {
  AI_DAILY_LIMIT,
  acquireAiUsageRequest,
  channelAiContextFor,
  releaseAiUsage,
} from "@/lib/ai-usage";

export const runtime = "nodejs";

type GenerationRow = {
  id: number;
  request_id: string;
  kind: "image" | "video";
  status: MediaGenerationStatus;
  prompt: string;
  negative_prompt: string | null;
  source_text: string | null;
  exact_text: string | null;
  model: string;
  aspect_ratio: string;
  quality: string | null;
  seconds: number | null;
  style: string;
  output_asset_id: number | null;
  mime_type: string | null;
  bytes: number | null;
  error_code: string | null;
  error_message: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  completed_at: Date | string | null;
  queue_confirmed_at?: Date | string | null;
};

function present(row: GenerationRow) {
  const assetId = row.output_asset_id ? String(row.output_asset_id) : null;
  return {
    id: String(row.id),
    requestId: row.request_id,
    kind: row.kind,
    status: row.status,
    prompt: row.prompt,
    negativePrompt: row.negative_prompt ?? "",
    sourceText: row.source_text ?? "",
    exactText: row.exact_text ?? "",
    model: row.model,
    aspectRatio: row.aspect_ratio,
    quality: row.quality,
    seconds: row.seconds,
    style: row.style,
    assetId,
    assetUrl: assetId ? `/api/media/assets/${assetId}` : null,
    downloadUrl: assetId ? `/api/media/assets/${assetId}?download=1` : null,
    mimeType: row.mime_type,
    bytes: row.bytes,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
  };
}

const SELECT_GENERATION = `
  select g.id, g.request_id, g.kind, g.status, g.prompt, g.negative_prompt,
         coalesce(g.prompt_context->>'sourcePost', '') as source_text,
         coalesce(g.prompt_context->>'exactText', '') as exact_text,
         g.model, g.aspect_ratio, g.quality, g.seconds,
         g.style, g.output_asset_id, g.error_code, g.error_message,
         g.created_at, g.updated_at, g.completed_at, g.queue_confirmed_at,
         a.mime_type, a.bytes
    from media_generations g
    left join media_assets a
      on a.id = g.output_asset_id and a.project_id = g.project_id`;

const activeGeneration = (status: MediaGenerationStatus) =>
  status === "queued" || status === "submitting" || status === "generating" || status === "saving";

function mediaResponse(
  requestId: string,
  body: Record<string, unknown>,
  status = 200,
) {
  return NextResponse.json(
    { ...body, requestId },
    { status, headers: { "x-request-id": requestId, "cache-control": "no-store" } },
  );
}

function mediaLog(
  event: string,
  context: { requestId: string; generationId?: number | null; code?: string; error?: unknown },
) {
  const technicalError = context.error && typeof context.error === "object"
    ? context.error as { code?: unknown; constraint?: unknown }
    : null;
  console.error("[media-api]", {
    event,
    requestId: context.requestId,
    generationId: context.generationId ?? null,
    code: context.code ?? null,
    errorName: context.error instanceof Error ? context.error.name : context.error ? "Error" : null,
    technicalCode: typeof technicalError?.code === "string" ? technicalError.code.slice(0, 64) : null,
    constraint: typeof technicalError?.constraint === "string" ? technicalError.constraint.slice(0, 128) : null,
  });
}

function mediaRequestKey(req: NextRequest): string | null {
  const value = req.headers.get("idempotency-key")?.trim() ?? "";
  return /^[A-Za-z0-9:_-]{8,96}$/u.test(value) ? value : null;
}

export async function GET(req: NextRequest) {
  const requestId = randomUUID();
  const user = await getSessionUser(req);
  if (!user) return mediaResponse(requestId, { generations: [], error: "unauthorized" }, 401);

  try {
    const pool = getPool();
    const membership = await requireSelectedProjectPermission(pool, user.id, "project.read");
    const rows = await pool.query<GenerationRow>(
      `${SELECT_GENERATION} where g.project_id = $1 order by g.created_at desc limit 24`,
      [membership.projectId],
    );
    return mediaResponse(requestId, { generations: rows.rows.map(present) });
  } catch (error) {
    if (error instanceof ProjectAccessError) {
      return mediaResponse(requestId, { generations: [], error: "project_access_denied" }, 403);
    }
    mediaLog("list_failed", { requestId, code: "server", error });
    return mediaResponse(requestId, { generations: [], error: "server" }, 500);
  }
}

export async function POST(req: NextRequest) {
  if (!hasTrustedMutationOrigin(req)) {
    return mediaResponse(randomUUID(), { error: "forbidden_origin" }, 403);
  }
  let requestId: string = randomUUID();
  const user = await getSessionUser(req);
  if (!user) return mediaResponse(requestId, { error: "unauthorized" }, 401);

  const pool = getPool();
  let membership;
  try {
    membership = await requireSelectedProjectPermission(pool, user.id, "content.create");
  } catch (error) {
    if (error instanceof ProjectAccessError) {
      return mediaResponse(requestId, { error: "project_access_denied" }, 403);
    }
    throw error;
  }

  const requestKey = mediaRequestKey(req);
  if (!requestKey) {
    return mediaResponse(requestId, { error: "idempotency_key_required" }, 400);
  }

  // Replay is available even while the provider or worker is temporarily down. It is a
  // read of the already-authorized logical request and can safely return current/result.
  try {
    await reconcileStaleMediaGeneration(pool, {
      userId: user.id,
      projectId: membership.projectId,
      requestKey,
    });
    const replay = await pool.query<GenerationRow>(
      `${SELECT_GENERATION} where g.project_id = $1 and g.request_key = $2`,
      [membership.projectId, requestKey],
    );
    if (replay.rows[0]) {
      requestId = replay.rows[0].request_id;
      return mediaResponse(
        requestId,
        { generation: present(replay.rows[0]), replayed: true },
        activeGeneration(replay.rows[0].status) ? 202 : 200,
      );
    }
  } catch (error) {
    mediaLog("replay_failed", { requestId, code: "server", error });
    return mediaResponse(requestId, { error: "server", retryable: true }, 500);
  }

  if (process.env.MEDIA_GENERATION_ENABLED === "false") {
    return mediaResponse(requestId, { error: "disabled" }, 503);
  }
  if (!process.env.NAVYAI_API_KEY) {
    return mediaResponse(requestId, { error: "not_configured" }, 503);
  }

  let raw: unknown;
  try {
    raw = await readJsonBodyValue(req);
  } catch {
    return mediaResponse(requestId, { error: "bad_request" }, 400);
  }
  const parsed = validateMediaInput(raw);
  if (!parsed.ok || !parsed.value) {
    return mediaResponse(requestId, { error: parsed.error || "bad_request" }, 422);
  }
  const input = parsed.value;
  let channelContext: Awaited<ReturnType<typeof channelAiContextFor>> = null;
  try {
    channelContext = input.channelId
      ? await channelAiContextFor(user.id, input.channelId)
      : null;
  } catch (error) {
    mediaLog("channel_context_failed", { requestId, code: "server", error });
    return mediaResponse(requestId, { error: "server", retryable: true }, 500);
  }
  if (input.channelId && !channelContext) {
    return mediaResponse(requestId, { error: "channel_not_found" }, 404);
  }
  // Browser state is never a brand-profile authority. Only the selected, owned channel's
  // server-side effective profile may enrich a paid provider request.
  const effectiveNiche = channelContext?.profileProvenance.niche?.value ?? "";
  const effectiveTone = channelContext?.profileProvenance.tone?.value ?? "";
  const promptContext = buildMediaPromptContext(input, {
    platform: channelContext?.network || "generic",
    brandProfile: channelContext?.profile || "",
    visualDirection: channelContext?.quality?.visualDirection || "",
    visualDetail: channelContext?.quality?.visualDetail || 0,
  });
  const providerRequestKey = `aurora-media-${requestId}`;
  const requestFingerprint = createHash("sha256")
    .update(JSON.stringify({ input, effectiveNiche, effectiveTone, promptContext }), "utf8")
    .digest("hex");

  if (!(await hasMediaWorker())) {
    return mediaResponse(requestId, { error: "worker_unavailable", retryable: true }, 503);
  }

  let capabilities;
  try {
    capabilities = await navyMediaCapabilities({
      apiKey: process.env.NAVYAI_API_KEY,
      baseUrl: process.env.NAVYAI_API_URL,
    });
  } catch (error) {
    mediaLog("capabilities_failed", { requestId, code: "provider_unavailable", error });
    return mediaResponse(requestId, { error: "provider_unavailable", retryable: true }, 503);
  }
  const modelAccess = capabilities.checked
    ? capabilities.models.find((model: { kind: string; id: string }) => model.kind === input.kind && model.id === input.model)
    : null;
  if (modelAccess && !modelAccess.available) {
    return mediaResponse(
      requestId,
      {
        error: "model_unavailable",
        model: input.model,
        requiredPlan: modelAccess.requiredPlan,
      },
      409,
    );
  }

  const dailyLimit = input.kind === "video"
    ? Number(process.env.MEDIA_VIDEO_DAILY_LIMIT || 3)
    : Number(process.env.MEDIA_IMAGE_DAILY_LIMIT || 10);
  const concurrentLimit = input.kind === "video" ? 1 : 2;
  let reservation;
  try {
    reservation = await acquireAiUsageRequest(user.id, `media-${input.kind}`, {
      reservationKey: `media:${requestKey}`,
      fingerprint: requestFingerprint,
      operationId: requestId,
      ttlMs: 60 * 60_000,
    });
  } catch (error) {
    mediaLog("reservation_failed", {
      requestId,
      code: "usage_unavailable",
      error,
    });
    return mediaResponse(
      requestId,
      { error: "usage_unavailable", retryable: true },
      503,
    );
  }
  if (reservation.requestState === "in_progress") {
    return mediaResponse(requestId, { error: "request_in_progress", retryable: true }, 409);
  }
  if (reservation.requestState === "conflict") {
    return mediaResponse(requestId, { error: "idempotency_key_conflict", retryable: false }, 409);
  }
  if (reservation.requestState === "replay" || reservation.requestState === "committed_without_result") {
    return mediaResponse(requestId, { error: "request_result_unavailable", retryable: false }, 409);
  }
  if (!reservation.allowed || reservation.reservationId == null) {
    return mediaResponse(
      requestId,
      { error: "limit", used: reservation.used, limit: reservation.limit, scope: "ai", retryable: false },
      429,
    );
  }

  const tx = await pool.connect();
  let generationId: number | null = null;
  let reservationHeld = true;
  try {
    await tx.query("begin");
    await tx.query(`select id from users where id = $1 for update`, [user.id]);
    const stale = await tx.query<{ ai_usage_reservation_id: string | null }>(
      `update media_generations
          set status = 'failed', error_code = 'stale_generation',
              error_message = 'Предыдущая генерация прервалась. Запусти её ещё раз.',
              updated_at = now(), completed_at = now()
        where user_id = $1 and kind = $2 and project_id = $3
          and status in ('queued','submitting','generating','saving')
          and updated_at < now() - interval '15 minutes'
        returning ai_usage_reservation_id`,
      [user.id, input.kind, membership.projectId],
    );
    const staleReservations = stale.rows
      .map((row) => Number(row.ai_usage_reservation_id))
      .filter((id) => Number.isSafeInteger(id) && id > 0);
    if (staleReservations.length) {
      await tx.query(
        `update ai_usage set status = 'released', finalized_at = now()
          where user_id = $1 and id = any($2::bigint[]) and status = 'reserved'`,
        [user.id, staleReservations],
      );
    }
    const counts = (
      await tx.query<{ used: string; active: string }>(
        `select count(*) filter (where created_at >= current_date and status <> 'failed') as used,
                count(*) filter (where status in ('queued','submitting','generating','saving')) as active
           from media_generations where user_id = $1 and kind = $2`,
        [user.id, input.kind],
      )
    ).rows[0];
    if (Number(counts.used) >= dailyLimit) {
      await tx.query("rollback");
      await releaseAiUsage(user.id, reservation.reservationId).catch(() => {});
      reservationHeld = false;
      return mediaResponse(requestId, { error: "limit", limit: dailyLimit, retryable: false }, 429);
    }
    if (Number(counts.active) >= concurrentLimit) {
      await tx.query("rollback");
      await releaseAiUsage(user.id, reservation.reservationId).catch(() => {});
      reservationHeld = false;
      return mediaResponse(requestId, { error: "already_generating", retryable: false }, 409);
    }

    const inserted = await tx.query<{ id: number }>(
      `insert into media_generations
        (user_id, project_id, kind, prompt, negative_prompt, model, aspect_ratio, quality, seconds,
         style, niche, tone, request_key, ai_usage_reservation_id, request_id,
         provider_request_key, prompt_policy_version, prompt_context)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) returning id`,
      [
        user.id,
        membership.projectId,
        input.kind,
        input.prompt,
        input.negativePrompt || null,
        input.model,
        input.aspectRatio,
        input.kind === "image" ? input.quality : null,
        input.kind === "video" ? input.seconds : null,
        input.style,
        effectiveNiche || null,
        effectiveTone || null,
        requestKey,
        reservation.reservationId,
        requestId,
        providerRequestKey,
        MEDIA_PROMPT_POLICY.version,
        promptContext,
      ],
    );
    generationId = inserted.rows[0].id;
    await tx.query("commit");
  } catch (error) {
    await tx.query("rollback").catch(() => {});
    if (reservationHeld) {
      await releaseAiUsage(user.id, reservation.reservationId).catch(() => {});
      reservationHeld = false;
    }
    mediaLog("create_failed", { requestId, generationId, code: "server", error });
    return mediaResponse(requestId, { error: "server", retryable: true }, 500);
  } finally {
    tx.release();
  }

  try {
    if (generationId == null) throw new Error("generation_id_missing");
    await enqueueMediaGeneration({
      generationId,
      projectId: membership.projectId,
      requestId,
      requestKey,
      providerRequestKey,
    });
    const confirmed = await pool.query(
      `update media_generations
          set queue_confirmed_at = now(), updated_at = now()
        where id = $1 and project_id = $2 and status = 'queued' and queue_confirmed_at is null`,
      [generationId, membership.projectId],
    );
    if ((confirmed.rowCount ?? 0) !== 1) throw new Error("queue_handoff_not_confirmed");
  } catch (error) {
    let compensated = false;
    try {
      const failed = await pool.query(
        `update media_generations set status = 'failed', error_code = 'queue_unavailable',
                error_message = 'Очередь генерации недоступна. Запусти генерацию ещё раз.',
                updated_at = now(), completed_at = now()
          where id = $1 and user_id = $2 and project_id = $3
            and status = 'queued' and queue_confirmed_at is null
        returning id`,
        [generationId, user.id, membership.projectId],
      );
      compensated = (failed.rowCount ?? 0) === 1;
    } catch {
      // Re-read below resolves an ACK/DB-response ambiguity without guessing.
    }
    if (!compensated) {
      try {
        const durable = await pool.query<GenerationRow>(
          `${SELECT_GENERATION} where g.id = $1 and g.user_id = $2 and g.project_id = $3`,
          [generationId, user.id, membership.projectId],
        );
        const row = durable.rows[0];
        if (row?.queue_confirmed_at) {
          return mediaResponse(
            row.request_id,
            { generation: present(row), replayed: true },
            activeGeneration(row.status) ? 202 : 200,
          );
        }
      } catch {
        // Keep the reservation fenced until replay/reconciliation can observe durable state.
      }
    }
    if (compensated && reservationHeld) {
      await releaseAiUsage(user.id, reservation.reservationId).catch(() => {});
      reservationHeld = false;
    }
    mediaLog("queue_handoff_failed", {
      requestId,
      generationId,
      code: "queue_unavailable",
      error,
    });
    return mediaResponse(requestId, { error: "queue_unavailable", retryable: true }, 503);
  }

  try {
    const row = await pool.query<GenerationRow>(
      `${SELECT_GENERATION} where g.id = $1 and g.user_id = $2 and g.project_id = $3`,
      [generationId, user.id, membership.projectId],
    );
    if (!row.rows[0]) throw new Error("generation_not_found_after_handoff");
    return mediaResponse(
      requestId,
      {
        generation: present(row.rows[0]),
        remaining: Math.max(0, dailyLimit - 1),
        aiUsage: { used: reservation.used, limit: AI_DAILY_LIMIT },
      },
      202,
    );
  } catch (error) {
    // The queue owns the confirmed reservation now. Do not release it on an HTTP read
    // failure; replaying the same client key returns the durable generation.
    mediaLog("handoff_response_failed", { requestId, generationId, code: "server", error });
    return mediaResponse(requestId, { error: "server", retryable: true }, 500);
  }
}
