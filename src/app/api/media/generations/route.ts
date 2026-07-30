import { NextRequest, NextResponse } from "next/server";

import { getPool } from "@/lib/db";
import { validateMediaInput } from "@/lib/media-generation.mjs";
import { getMediaQueue } from "@/lib/queue";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";

type GenerationRow = {
  id: number;
  kind: "image" | "video";
  status: "queued" | "submitting" | "generating" | "saving" | "ready" | "failed";
  prompt: string;
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
};

function present(row: GenerationRow) {
  const assetId = row.output_asset_id ? String(row.output_asset_id) : null;
  return {
    id: String(row.id),
    kind: row.kind,
    status: row.status,
    prompt: row.prompt,
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
  select g.id, g.kind, g.status, g.prompt, g.model, g.aspect_ratio, g.quality, g.seconds,
         g.style, g.output_asset_id, g.error_code, g.error_message,
         g.created_at, g.updated_at, g.completed_at, a.mime_type, a.bytes
    from media_generations g
    left join media_assets a on a.id = g.output_asset_id`;

export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ generations: [] }, { status: 401 });

  try {
    const rows = await getPool().query<GenerationRow>(
      `${SELECT_GENERATION} where g.user_id = $1 order by g.created_at desc limit 24`,
      [user.id],
    );
    return NextResponse.json({ generations: rows.rows.map(present) });
  } catch (error) {
    console.error("[/api/media/generations GET]", error);
    return NextResponse.json({ generations: [], error: "server" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (process.env.MEDIA_GENERATION_ENABLED === "false") {
    return NextResponse.json({ error: "disabled" }, { status: 503 });
  }
  if (!process.env.NAVYAI_API_KEY) {
    return NextResponse.json({ error: "not_configured" }, { status: 503 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const parsed = validateMediaInput(raw);
  if (!parsed.ok || !parsed.value) {
    return NextResponse.json({ error: parsed.error || "bad_request" }, { status: 422 });
  }
  const input = parsed.value;

  const dailyLimit = input.kind === "video"
    ? Number(process.env.MEDIA_VIDEO_DAILY_LIMIT || 3)
    : Number(process.env.MEDIA_IMAGE_DAILY_LIMIT || 10);
  const concurrentLimit = input.kind === "video" ? 1 : 2;
  const pool = getPool();
  const tx = await pool.connect();
  let generationId: number | null = null;
  try {
    await tx.query("begin");
    await tx.query(`select id from users where id = $1 for update`, [user.id]);
    const counts = (
      await tx.query<{ used: string; active: string }>(
        `select count(*) filter (where created_at >= current_date) as used,
                count(*) filter (where status in ('queued','submitting','generating','saving')) as active
           from media_generations where user_id = $1 and kind = $2`,
        [user.id, input.kind],
      )
    ).rows[0];
    if (Number(counts.used) >= dailyLimit) {
      await tx.query("rollback");
      return NextResponse.json({ error: "limit", limit: dailyLimit }, { status: 429 });
    }
    if (Number(counts.active) >= concurrentLimit) {
      await tx.query("rollback");
      return NextResponse.json({ error: "already_generating" }, { status: 409 });
    }

    const inserted = await tx.query<{ id: number }>(
      `insert into media_generations
        (user_id, kind, prompt, negative_prompt, model, aspect_ratio, quality, seconds, style, niche, tone)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`,
      [
        user.id,
        input.kind,
        input.prompt,
        input.negativePrompt || null,
        input.model,
        input.aspectRatio,
        input.kind === "image" ? input.quality : null,
        input.kind === "video" ? input.seconds : null,
        input.style,
        input.niche || null,
        input.tone || null,
      ],
    );
    generationId = inserted.rows[0].id;
    await tx.query("commit");
  } catch (error) {
    await tx.query("rollback").catch(() => {});
    console.error("[/api/media/generations POST]", error);
    return NextResponse.json({ error: "server" }, { status: 500 });
  } finally {
    tx.release();
  }

  try {
    await getMediaQueue().add(
      "generate",
      { generationId },
      {
        jobId: `media-${generationId}`,
        removeOnComplete: 50,
        removeOnFail: 100,
      },
    );
  } catch (error) {
    await pool.query(
      `update media_generations set status = 'failed', error_code = 'queue_unavailable',
              error_message = 'Очередь генерации недоступна. Попробуй ещё раз.', updated_at = now()
        where id = $1`,
      [generationId],
    );
    console.error("[/api/media/generations queue]", error);
    return NextResponse.json({ error: "queue_unavailable" }, { status: 503 });
  }

  const row = await pool.query<GenerationRow>(
    `${SELECT_GENERATION} where g.id = $1 and g.user_id = $2`,
    [generationId, user.id],
  );
  return NextResponse.json(
    { generation: present(row.rows[0]), remaining: Math.max(0, dailyLimit - 1) },
    { status: 202 },
  );
}
