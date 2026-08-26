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
import { enqueueKnowledgeIndex } from "@/lib/knowledge-index-queue.mjs";
import { resolveChannel } from "@/lib/autopilot";
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
}

export async function GET(req: NextRequest) {
  try {
    const user = await getSessionUser(req);
    if (!user) {
      return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }
    const pool = getPool();
    const channelId = await resolveChannel(user.id, Number(req.nextUrl.searchParams.get("channel")) || null);
    if (!channelId) {
      return NextResponse.json({
        ok: true,
        sources: [],
        facts: 0,
        voice: 0,
        channelId: null,
        effectiveProfile: {},
      });
    }

    const sources = (
      await pool.query<SourceRow>(
        `select s.id, s.kind, s.title, s.status, s.last_error, s.added_at, s.indexed_at,
                (select count(*)::int from knowledge_chunks k where k.source_id = s.id) as chunks
           from knowledge_sources s
          where s.channel_id = $1
          order by s.added_at desc`,
        [channelId],
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
      effectiveProfile: context?.profileProvenance ?? {},
    });
  } catch (err) {
    console.error("[/api/knowledge] GET", {
      errorName: err instanceof Error ? err.name : "Error",
    });
    return NextResponse.json({ ok: false, error: "unavailable" }, { status: 503 });
  }
}

export async function POST(req: NextRequest) {
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
    const pool = getPool();
    const channelId = await resolveChannel(user.id, Number(body.channelId) || null);
    if (!channelId) return NextResponse.json({ ok: false, error: "no_channel" }, { status: 422 });

    const ins = await pool.query<{ id: number }>(
      `insert into knowledge_sources (user_id, channel_id, kind, title, raw_text)
       values ($1, $2, $3, $4, $5) returning id`,
      [user.id, channelId, kind, title, text],
    );
    const id = Number(ins.rows[0].id);

    // Векторы считает воркер: это поход наружу (Ollama/облако), у него очередь и повторы.
    // Роут ждать не должен — человек увидит «считаю» и через секунды «готово».
    await enqueueKnowledgeIndex(getStatsQueue(), id)
      .catch(() => {
        /* Источник сохранён в pending; периодическая DB→queue сверка подберёт его позже. */
      });

    return NextResponse.json({ ok: true, id });
  } catch (err) {
    console.error("[/api/knowledge] POST", err);
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}

/** Убрать источник целиком — куски уедут каскадом. */
export async function DELETE(req: NextRequest) {
  if (!hasTrustedMutationOrigin(req)) {
    return NextResponse.json({ ok: false, error: "forbidden_origin" }, { status: 403 });
  }
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const id = Number(req.nextUrl.searchParams.get("id"));
  if (!Number.isInteger(id)) return NextResponse.json({ ok: false, error: "bad_id" }, { status: 422 });

  try {
    const r = await getPool().query(`delete from knowledge_sources where id = $1 and user_id = $2`, [
      id,
      user.id,
    ]);
    if (!r.rowCount) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[/api/knowledge] DELETE", err);
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}
