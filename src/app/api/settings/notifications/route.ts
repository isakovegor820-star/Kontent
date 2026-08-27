import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  isCompleteNotificationPreferences,
  normalizeNotificationPreferences,
} from "@/lib/account-settings";
import { readJsonBodyValue } from "@/lib/bounded-request-body";
import { getPool } from "@/lib/db";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const requestId = randomUUID();
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized", requestId }, { status: 401 });
  try {
    const row = (
      await getPool().query<{ notification_preferences: unknown }>(
        `select notification_preferences from user_account_settings where user_id = $1`,
        [user.id],
      )
    ).rows[0];
    return NextResponse.json({
      ok: true,
      preferences: normalizeNotificationPreferences(row?.notification_preferences ?? DEFAULT_NOTIFICATION_PREFERENCES),
      availability: { inApp: true, email: Boolean(user.email), telegram: user.tg_id != null },
      requestId,
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error("[/api/settings/notifications] GET", {
      requestId,
      errorName: error instanceof Error ? error.name : "Error",
    });
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
  const body = await readJsonBodyValue(req).catch(() => null) as { preferences?: unknown } | null;
  if (!isCompleteNotificationPreferences(body?.preferences)) {
    return NextResponse.json({ ok: false, error: "bad_preferences", requestId }, { status: 422 });
  }
  const preferences = normalizeNotificationPreferences(body.preferences);
  try {
    const updated = await getPool().query<{ updated_at: Date | string }>(
      `insert into user_account_settings (user_id, display_name, notification_preferences, updated_at)
       values ($1,$2,$3::jsonb,now())
       on conflict (user_id) do update
         set notification_preferences = excluded.notification_preferences, updated_at = now()
       returning updated_at`,
      [user.id, user.name ?? "Пользователь", JSON.stringify(preferences)],
    );
    return NextResponse.json({
      ok: true,
      preferences,
      savedAt: new Date(updated.rows[0]?.updated_at ?? Date.now()).toISOString(),
      requestId,
    });
  } catch (error) {
    console.error("[/api/settings/notifications] POST", {
      requestId,
      errorName: error instanceof Error ? error.name : "Error",
    });
    return NextResponse.json({ ok: false, error: "unavailable", requestId }, { status: 503 });
  }
}
