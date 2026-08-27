import { createHash, randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { completeAiText } from "@/lib/ai-completion-service.mjs";
import { buildSystemPrompt, type GenerateParams } from "@/lib/ai-provider";
import { channelAiContextFor } from "@/lib/ai-usage";
import { readJsonBodyValue } from "@/lib/bounded-request-body";
import { getPool } from "@/lib/db";
import { isEngineId } from "@/lib/engines";
import { normalizePostSettings } from "@/lib/post-settings";
import { ProjectAccessError, requireSelectedProjectPermission } from "@/lib/project-permissions";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";
import {
  buildSettingsApplicationReport,
  SETTINGS_PREVIEW_DAILY_LIMIT,
} from "@/lib/settings-preview";

export const runtime = "nodejs";

type PreviewBody = { channelId?: unknown; topic?: unknown };

function cleanTopic(value: unknown): string | null {
  const topic = String(value ?? "").replace(/\s+/gu, " ").trim().slice(0, 500);
  return topic.length >= 3 ? topic : null;
}

async function reservePreview(input: {
  userId: number;
  projectId: number;
  channelId: number;
  topic: string;
  applied: unknown;
}) {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock($1::bigint)", [input.userId]);
    const used = Number((
      await client.query<{ used: string }>(
        `select count(*)::text as used from settings_preview_runs
          where user_id = $1 and usage_date = current_date`,
        [input.userId],
      )
    ).rows[0]?.used ?? 0);
    if (used >= SETTINGS_PREVIEW_DAILY_LIMIT) {
      await client.query("rollback");
      return { id: null, used };
    }
    const row = (
      await client.query<{ id: string }>(
        `insert into settings_preview_runs
           (user_id, project_id, channel_id, topic, applied_settings)
         values ($1,$2,$3,$4,$5::jsonb)
         returning id`,
        [input.userId, input.projectId, input.channelId, input.topic, JSON.stringify(input.applied)],
      )
    ).rows[0];
    await client.query("commit");
    return { id: row ? Number(row.id) : null, used: used + 1 };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function GET(req: NextRequest) {
  const requestId = randomUUID();
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized", requestId }, { status: 401 });
  try {
    const used = Number((
      await getPool().query<{ used: string }>(
        `select count(*)::text as used from settings_preview_runs
          where user_id = $1 and usage_date = current_date`,
        [user.id],
      )
    ).rows[0]?.used ?? 0);
    return NextResponse.json({
      ok: true,
      used,
      limit: SETTINGS_PREVIEW_DAILY_LIMIT,
      remaining: Math.max(0, SETTINGS_PREVIEW_DAILY_LIMIT - used),
      requestId,
    }, { headers: { "cache-control": "no-store" } });
  } catch {
    return NextResponse.json({ ok: false, error: "unavailable", requestId }, { status: 503 });
  }
}

export async function POST(req: NextRequest) {
  const requestId = randomUUID();
  if (!hasTrustedMutationOrigin(req)) {
    return NextResponse.json({ ok: false, error: "forbidden_origin", requestId }, { status: 403 });
  }
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized", requestId }, { status: 401 });
  const body = await readJsonBodyValue(req).catch(() => null) as PreviewBody | null;
  const channelId = Number(body?.channelId);
  const topic = cleanTopic(body?.topic);
  if (!Number.isSafeInteger(channelId) || channelId <= 0 || !topic) {
    return NextResponse.json({ ok: false, error: "bad_request", requestId }, { status: 422 });
  }
  try {
    const pool = getPool();
    const membership = await requireSelectedProjectPermission(pool, user.id, "content.edit");
    const channelInProject = await pool.query(
      `select 1
         from channels
        where id = $1 and user_id = $2 and project_id = $3 and is_active = true`,
      [channelId, user.id, membership.projectId],
    );
    if (!channelInProject.rowCount) {
      return NextResponse.json({ ok: false, error: "channel_not_found", requestId }, { status: 404 });
    }
    const channel = await channelAiContextFor(user.id, channelId, 30, pool);
    if (!channel) return NextResponse.json({ ok: false, error: "channel_not_found", requestId }, { status: 404 });
    const userSettings = (
      await pool.query<{ ai_engine: string | null; ai_mood: string | null; ai_post_settings: unknown }>(
        `select ai_engine, ai_mood, ai_post_settings from users where id = $1`,
        [user.id],
      )
    ).rows[0];
    const postSettings = normalizePostSettings(userSettings?.ai_post_settings);
    const params: GenerateParams = {
      kind: "write",
      task: topic,
      channelTitle: channel.title,
      network: channel.network,
      channelProfile: channel.profile,
      channelQuality: channel.quality,
      channelPostIndex: channel.postIndex,
      knownFacts: channel.facts,
      styleSamples: channel.styleSamples,
      postSettings,
      mood: userSettings?.ai_mood ?? undefined,
      grounding: "platform",
    };
    const report = buildSettingsApplicationReport(channel);
    const reservation = await reservePreview({
      userId: user.id,
      projectId: membership.projectId,
      channelId,
      topic,
      applied: report,
    });
    if (!reservation.id) {
      return NextResponse.json({
        ok: false,
        error: "preview_limit",
        used: reservation.used,
        limit: SETTINGS_PREVIEW_DAILY_LIMIT,
        requestId,
      }, { status: 429 });
    }
    try {
      const providerKey = createHash("sha256")
        .update(`settings-preview:${reservation.id}:${user.id}`, "utf8")
        .digest("hex");
      const completion = await completeAiText({
        engine: isEngineId(userSettings?.ai_engine) ? userSettings.ai_engine : undefined,
        providerRequestKey: providerKey,
        providerRequestId: requestId,
        messages: [
          { role: "system", content: buildSystemPrompt(params) },
          { role: "user", content: `Напиши один тестовый пост на тему: ${topic}. Верни только готовый текст без комментариев о настройках.` },
        ],
        temperature: 0.45,
        maxTokens: 1400,
        acceptLengthLimitedOutput: true,
      });
      await pool.query(
        `update settings_preview_runs
            set status = 'succeeded', result_text = $2, completed_at = now()
          where id = $1 and user_id = $3`,
        [reservation.id, completion.text, user.id],
      );
      return NextResponse.json({
        ok: true,
        text: completion.text,
        report,
        engine: completion.engine,
        used: reservation.used,
        limit: SETTINGS_PREVIEW_DAILY_LIMIT,
        remaining: Math.max(0, SETTINGS_PREVIEW_DAILY_LIMIT - reservation.used),
        requestId,
      }, { headers: { "cache-control": "no-store" } });
    } catch (error) {
      const code = error instanceof Error ? error.name : "preview_failed";
      await pool.query(
        `update settings_preview_runs
            set status = 'failed', error_code = $2, completed_at = now()
          where id = $1 and user_id = $3`,
        [reservation.id, code.slice(0, 80), user.id],
      ).catch(() => undefined);
      return NextResponse.json({
        ok: false,
        error: "preview_provider_unavailable",
        used: reservation.used,
        limit: SETTINGS_PREVIEW_DAILY_LIMIT,
        remaining: Math.max(0, SETTINGS_PREVIEW_DAILY_LIMIT - reservation.used),
        requestId,
      }, { status: 503, headers: { "cache-control": "no-store" } });
    }
  } catch (error) {
    if (error instanceof ProjectAccessError) {
      return NextResponse.json({ ok: false, error: "access_denied", requestId }, { status: 403 });
    }
    console.error("[/api/settings/preview] POST", {
      requestId,
      errorName: error instanceof Error ? error.name : "Error",
    });
    return NextResponse.json({ ok: false, error: "preview_unavailable", requestId }, { status: 503 });
  }
}
