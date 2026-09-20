import { withProjectRoute } from "@/lib/project-route";
// База знаний канала (РАГ). Отсюда автопилот берёт ФАКТЫ для постов.
//
// Зачем это вообще: ИИ выдумывал. В канал ушло «решение Судьи Московского округа от
// 10 июля 2026 года» — такого решения нет. Взять правду ему было негде: в задание
// уходили только бриф и пара своих постов, ни одного факта. Теперь факты — отсюда.
//
// База — НА КАНАЛЕ, как и автопилот: у двух каналов разные ниши, и знание одного
// не должно течь в посты другого.

import { JsonBodyReadError, readJsonBodyValue } from "@/lib/bounded-request-body";
import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { getStatsQueue } from "@/lib/queue";
import { resolveEmbeddingConfig } from "@/lib/embedding-config.mjs";
import { enqueueKnowledgeIndex } from "@/lib/knowledge-index-queue.mjs";
import { deleteKnowledgeSource, knowledgeChannelSelector, knowledgeFailure, withKnowledgeChannel } from "@/lib/knowledge-access";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { channelAiContextFor } from "@/lib/ai-usage";

export const runtime = "nodejs";

const MAX_TEXT = 40_000; // ~20 страниц за раз; больше — это уже файл, а загрузки файлов пока нет
const MAX_KNOWLEDGE_BODY_BYTES = MAX_TEXT * 4 + 16_384;
const KINDS = ["form", "paste", "channel"] as const;

interface SourceRow {
  id: number;
  kind: string;
  title: string;
  status: string;
  last_error: string | null;
  added_at: string;
  indexed_at: string | null;
  chunks: number;
  semantic_ready: boolean;
  embedding_error_code: string | null;
  text_indexed_at: string | null;
  next_retry_at: string | null;
  last_attempt_at: string | null;
  embedding_attempts: number;
}

async function handleGET(req: NextRequest) {
  try {
    const user = await getSessionUser(req);
    if (!user) {
      return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }
    try {
      return await withKnowledgeChannel(getPool(), user.id, knowledgeChannelSelector(req.nextUrl.searchParams.get("channel")), "project.read", async (pool, channel) => {
        const channelId = channel.id;
        const embeddingConfig = resolveEmbeddingConfig();

        const sources = (
          await pool.query<SourceRow>(
            `select s.id, s.kind, s.title, s.status, s.last_error, s.added_at, s.indexed_at, s.text_indexed_at, s.embedding_error_code, s.next_retry_at, s.last_attempt_at, s.embedding_attempts,
                    (s.indexed_at is not null and s.embedding_model=$2 and s.embedding_error_code is null) as semantic_ready,
                    (select count(*)::int from knowledge_chunks k where k.source_id = s.id) as chunks
               from knowledge_sources s
              where s.channel_id = $1
              order by s.added_at desc`,
            [channelId, embeddingConfig.identity],
          )
        ).rows;

        // Считаем ФАКТЫ отдельно от голоса: голос (посты канала) — образец стиля, опорой
        // для утверждений он быть не может. Человек должен видеть именно счётчик опоры,
        // иначе «в базе 40 кусков» создаст ложное чувство, что писать есть о чём.
        const counts = (
          await pool.query<{ facts: number; voice: number }>(
            `select count(*) filter (where kind <> 'voice')::int as facts,
                    count(*) filter (where kind = 'voice')::int  as voice
               from knowledge_chunks where channel_id = $1`,
            [channelId],
          )
        ).rows[0];
        const context = await channelAiContextFor(user.id, channelId, 10, pool);

        return NextResponse.json({
          ok: true,
          sources: sources.map((s) => ({ ...s, id: Number(s.id) })),
          facts: counts.facts,
          voice: counts.voice,
          channelId,
          embedding: { provider: embeddingConfig.provider, model: embeddingConfig.model, dimensions: embeddingConfig.dimensions },
          effectiveProfile: context?.profileProvenance ?? {},
          projectId: channel.projectId,
        });
      });
    } catch (error) {
      const failure = knowledgeFailure(error);
      if (failure?.error === "no_channel" && !req.nextUrl.searchParams.get("channel")) {
        return NextResponse.json({ ok: true, sources: [], facts: 0, voice: 0, channelId: null, effectiveProfile: {} });
      }
      throw error;
    }
  } catch (err) {
    const failure = knowledgeFailure(err);
    if (failure) return NextResponse.json({ ok: false, error: failure.error }, { status: failure.status });
    console.error("[/api/knowledge] GET", {
      errorName: err instanceof Error ? err.name : "Error",
    });
    return NextResponse.json({ ok: false, error: "unavailable" }, { status: 503 });
  }
}

async function handlePOST(req: NextRequest) {
  if (!hasTrustedMutationOrigin(req)) {
    return NextResponse.json({ ok: false, error: "forbidden_origin" }, { status: 403 });
  }
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  let body: { channelId?: unknown; kind?: unknown; title?: unknown; text?: unknown };
  try {
    body = await readJsonBodyValue(req, MAX_KNOWLEDGE_BODY_BYTES);
  } catch (error) {
    const status = error instanceof JsonBodyReadError ? error.status : 400;
    const code = error instanceof JsonBodyReadError ? error.code : "bad_request";
    return NextResponse.json({ ok: false, error: code }, { status });
  }

  const kind = String(body.kind ?? "paste");
  if (!KINDS.includes(kind as (typeof KINDS)[number])) {
    return NextResponse.json({ ok: false, error: "bad_kind" }, { status: 422 });
  }
  const text = String(body.text ?? "").trim();
  const title = String(body.title ?? "").trim().slice(0, 120);
  if (!text) return NextResponse.json({ ok: false, error: "empty" }, { status: 422 });
  if (text.length > MAX_TEXT) {
    return NextResponse.json({ ok: false, error: "too_long", max: MAX_TEXT }, { status: 422 });
  }
  if (!title) return NextResponse.json({ ok: false, error: "no_title" }, { status: 422 });

  try {
    const id = await withKnowledgeChannel(getPool(), user.id, knowledgeChannelSelector(body.channelId), "content.edit", async (pool, channel) => {
      const ins = await pool.query<{ id: number }>(
        `insert into knowledge_sources (user_id, channel_id, kind, title, raw_text)
         values ($1, $2, $3, $4, $5) returning id`,
        [user.id, channel.id, kind, title, text],
      );
      return Number(ins.rows[0].id);
    });

    // Векторы считает воркер: это поход наружу (Ollama/облако), у него очередь и повторы.
    // Роут подтверждает сохранение; готовность текста и семантического поиска видны отдельно.
    let queued = false;
    try { await enqueueKnowledgeIndex(getStatsQueue(), id); queued = true; }
    catch { console.warn("[knowledge] enqueue deferred", { sourceId: id, code: "knowledge_queue_unavailable" }); }
    return NextResponse.json({ ok: true, id, queued });
  } catch (err) {
    const failure = knowledgeFailure(err);
    if (failure) return NextResponse.json({ ok: false, error: failure.error }, { status: failure.status });
    console.error("[/api/knowledge] POST", err);
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}

/** Requeue only a source in a channel the actor may edit; preserve readable text. */
async function handlePUT(req: NextRequest) {
  if (!hasTrustedMutationOrigin(req)) return NextResponse.json({ ok: false, error: "forbidden_origin" }, { status: 403 });
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  try {
    const body = await readJsonBodyValue<{ channelId?: unknown; sourceId?: unknown }>(req);
    const sourceId = Number(body.sourceId);
    if (!Number.isSafeInteger(sourceId) || sourceId <= 0) return NextResponse.json({ ok: false, error: "bad_id" }, { status: 422 });
    const updated = await withKnowledgeChannel(getPool(), user.id, knowledgeChannelSelector(body.channelId), "content.edit", async (db, channel) => {
      return db.query(`update knowledge_sources set embedding_attempts=0, next_retry_at=now(),
        embedding_error_code='embedding_retry_requested', last_error=null
        where id=$1 and channel_id=$2 and status <> 'error' returning id`, [sourceId, channel.id]);
    });
    if (!updated.rowCount) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
    let queued = false;
    try { await enqueueKnowledgeIndex(getStatsQueue(), sourceId); queued = true; }
    catch { console.warn("[knowledge] retry enqueue deferred", { sourceId, code: "knowledge_queue_unavailable" }); }
    return NextResponse.json({ ok: true, queued });
  } catch (error) {
    const failure = knowledgeFailure(error);
    const status = error instanceof JsonBodyReadError ? error.status : failure?.status ?? 500;
    return NextResponse.json({ ok: false, error: failure?.error ?? "retry_unavailable" }, { status });
  }
}

/** Убрать источник целиком — куски уедут каскадом. */
async function handleDELETE(req: NextRequest) {
  if (!hasTrustedMutationOrigin(req)) {
    return NextResponse.json({ ok: false, error: "forbidden_origin" }, { status: 403 });
  }
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const id = Number(req.nextUrl.searchParams.get("id"));
  if (!Number.isSafeInteger(id) || id <= 0) return NextResponse.json({ ok: false, error: "bad_id" }, { status: 422 });

  try {
    await deleteKnowledgeSource(getPool(), user.id, id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const failure = knowledgeFailure(err);
    if (failure) return NextResponse.json({ ok: false, error: failure.error }, { status: failure.status });
    console.error("[/api/knowledge] DELETE", err);
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}

export const GET = withProjectRoute(handleGET);
export const POST = withProjectRoute(handlePOST);
export const DELETE = withProjectRoute(handleDELETE);

export const PUT = withProjectRoute(handlePUT);
