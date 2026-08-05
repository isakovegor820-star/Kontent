// Настройки пользователя. Настроение — связка из 1–3 редакторских профилей на аккаунт.
// В БД хранится JSON-массив; старые одиночные ключи продолжаем читать без миграции.

import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import {
  MOODS,
  DEFAULT_MOOD,
  isMoodSelection,
  normalizeMoodSelection,
} from "@/lib/moods";
import { compactPostSettings, normalizePostSettings } from "@/lib/post-settings";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";

export const runtime = "nodejs";

const MOOD_LIST = Object.entries(MOODS).map(([key, m]) => ({
  key,
  label: m.label,
  emoji: m.emoji,
  description: m.description,
}));

export async function GET(req: NextRequest) {
  const fallback = {
    mood: [DEFAULT_MOOD],
    moods: MOOD_LIST,
    postSettings: normalizePostSettings(null),
  };
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json(fallback);
  try {
    const r = await getPool().query<{ ai_mood: string | null; ai_post_settings: unknown }>(
      `select ai_mood, ai_post_settings from users where id = $1`,
      [user.id],
    );
    const raw = r.rows[0]?.ai_mood;
    const mood = normalizeMoodSelection(raw);
    const postSettings = normalizePostSettings(r.rows[0]?.ai_post_settings);
    return NextResponse.json({ mood, moods: MOOD_LIST, postSettings });
  } catch (err) {
    console.error("[/api/settings]", err);
    return NextResponse.json(fallback);
  }
}

export async function POST(req: NextRequest) {
  if (!hasTrustedMutationOrigin(req)) {
    return NextResponse.json({ ok: false, error: "forbidden_origin" }, { status: 403 });
  }
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  let body: { mood?: unknown; postSettings?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  }
  const hasMood = Object.prototype.hasOwnProperty.call(body, "mood");
  const hasPostSettings = Object.prototype.hasOwnProperty.call(body, "postSettings");
  if (!hasMood && !hasPostSettings) {
    return NextResponse.json({ ok: false, error: "empty_settings" }, { status: 422 });
  }
  if (hasMood && !isMoodSelection(body.mood)) {
    return NextResponse.json({ ok: false, error: "bad_mood" }, { status: 422 });
  }
  if (hasPostSettings && (!body.postSettings || typeof body.postSettings !== "object" || Array.isArray(body.postSettings))) {
    return NextResponse.json({ ok: false, error: "bad_post_settings" }, { status: 422 });
  }

  try {
    const mood = hasMood ? normalizeMoodSelection(body.mood) : null;
    const postSettings = hasPostSettings ? normalizePostSettings(body.postSettings) : null;
    const compact = postSettings ? compactPostSettings(postSettings) : null;
    await getPool().query(
      `update users
          set ai_mood = case when $2::boolean then $3 else ai_mood end,
              ai_post_settings = case when $4::boolean then $5::jsonb else ai_post_settings end
        where id = $1`,
      [
        user.id,
        hasMood,
        mood ? JSON.stringify(mood) : null,
        hasPostSettings,
        compact ? JSON.stringify(compact) : null,
      ],
    );
    return NextResponse.json({
      ok: true,
      ...(mood ? { mood } : {}),
      ...(postSettings ? { postSettings } : {}),
    });
  } catch (err) {
    console.error("[/api/settings] POST", err);
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}
