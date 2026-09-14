// Действия над уже проверенным результатом радара. Клиент передаёт только id; URL,
// handle и текст всегда перечитываются из user-scoped строки, поэтому подменить источник
// или сохранить чужую находку нельзя.

import { readJsonBodyValue } from "@/lib/bounded-request-body";
import { NextRequest, NextResponse } from "next/server";

import { resolveChannel } from "@/lib/autopilot";
import { MAX_COMPETITORS } from "@/lib/competitors";
import { getPool } from "@/lib/db";
import { getStatsQueue } from "@/lib/queue";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";

function json(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  if (!hasTrustedMutationOrigin(req)) {
    return json({ error: "forbidden_origin" }, 403);
  }
  const user = await getSessionUser(req);
  if (!user) return json({ error: "unauthorized" }, 401);
  const resultId = Number((await ctx.params).id);
  if (!Number.isSafeInteger(resultId) || resultId <= 0) return json({ error: "not_found" }, 404);
  let body: Record<string, unknown>;
  try {
    body = await readJsonBodyValue(req);
  } catch {
    return json({ error: "bad_request" }, 400);
  }
  const action = String(body.action || "");
  if (!["add_competitor", "save_idea", "save_reference"].includes(action)) {
    return json({ error: "bad_action" }, 422);
  }

  const wantedChannel = Number(body.channelId) || null;
  const channelId = await resolveChannel(user.id, wantedChannel);
  if (!channelId) return json({ error: "no_channel" }, 422);
  const pool = getPool();
  try {
    const result = (
      await pool.query<{
        id: string;
        result_type: string;
        handle: string | null;
        title: string | null;
        description: string | null;
        subscribers: number | null;
        text: string | null;
        url: string;
        reason: string;
        query: string;
        raw_data: Record<string, unknown>;
      }>(
        `select result.id, result.result_type, result.handle, result.title, result.description,
                result.subscribers, result.text, result.url, result.reason, result.raw_data, run.query
           from radar_search_results result
           join radar_search_runs run on run.id = result.run_id and run.user_id = $2
          where result.id = $1 and result.user_id = $2
            and result.verification_status = 'verified'`,
        [resultId, user.id],
      )
    ).rows[0];
    if (!result) return json({ error: "not_found" }, 404);

    if (action === "add_competitor") {
      if (result.result_type !== "channel" || !result.handle) {
        return json({ error: "channel_result_required" }, 422);
      }
      const count = (
        await pool.query<{ n: number }>(
          `select count(*)::int as n from competitors where channel_id = $1 and network = 'tg'`,
          [channelId],
        )
      ).rows[0].n;
      if (count >= MAX_COMPETITORS) return json({ error: "limit", limit: MAX_COMPETITORS }, 409);

      const existing = await pool.query<{ id: string }>(
        `select id from competitors where channel_id = $1 and network = 'tg' and handle = $2`,
        [channelId, result.handle],
      );
      if (existing.rows[0]) {
        return json({ ok: true, alreadyAdded: true, id: Number(existing.rows[0].id), handle: result.handle });
      }

      const inserted = await pool.query<{ id: string }>(
        `insert into competitors
           (user_id, channel_id, network, handle, title, subscribers, status, auto_added)
         values ($1, $2, 'tg', $3, $4, $5, 'pending', false)
         on conflict (channel_id, network, handle) do nothing
         returning id`,
        [user.id, channelId, result.handle, result.title, result.subscribers],
      );
      const competitorId = Number(inserted.rows[0]?.id);
      if (competitorId) {
        try {
          await getStatsQueue().add(
            "competitor",
            { id: competitorId },
            { removeOnComplete: true, attempts: 2, backoff: { type: "fixed", delay: 15_000 } },
          );
        } catch (error) {
          await pool.query(`delete from competitors where id = $1 and status = 'pending'`, [competitorId]);
          throw error;
        }
      }
      return json({ ok: true, id: competitorId, handle: result.handle });
    }

    const evidenceSources = Array.isArray(result.raw_data?.sources)
      ? result.raw_data.sources.flatMap((source, index) => {
          if (!source || typeof source !== "object" || Array.isArray(source)) return [];
          const record = source as Record<string, unknown>;
          const url = String(record.url || "");
          if (!/^https?:\/\//iu.test(url)) return [];
          return [`[${Number(record.id) || index + 1}] ${String(record.title || record.domain || "Источник")} — ${url}`];
        }).slice(0, 8)
      : [];
    const baseText = String(result.text || result.description || result.title || "").trim();
    const text = [baseText, evidenceSources.length ? `Источники:\n${evidenceSources.join("\n")}` : ""]
      .filter(Boolean)
      .join("\n\n");
    if (!text) return json({ error: "empty_result" }, 422);
    const saved = await pool.query<{ id: string }>(
      `insert into saved_posts
         (user_id, channel_id, kind, source_title, source_url, text, note, tags)
       values ($1, $2, 'reference', $3, $4, $5, $6, $7)
       on conflict (user_id, channel_id, source_url)
         where kind = 'reference' and source_url is not null
       do update set source_title = excluded.source_title,
                     text = excluded.text,
                     note = excluded.note,
                     tags = excluded.tags
       returning id`,
      [
        user.id,
        channelId,
        result.title || (result.handle ? `@${result.handle}` : "Публичный источник"),
        result.url,
        text.slice(0, 16_384),
        `Найдено по запросу «${result.query}». ${result.reason}`.slice(0, 300),
        ["разведка", result.query.slice(0, 60)],
      ],
    );
    return json({ ok: true, id: Number(saved.rows[0]?.id), saved: true });
  } catch (error) {
    console.error("[/api/radar/results/:id] POST", error);
    return json({ error: "action_unavailable" }, 503);
  }
}
