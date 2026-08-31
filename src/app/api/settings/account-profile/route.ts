import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { parseAccountProfileUpdate } from "@/lib/account-settings";
import { readJsonBodyValue } from "@/lib/bounded-request-body";
import { getPool } from "@/lib/db";
import { phoneVerificationMode } from "@/lib/phone-verification-mode.mjs";
import { normalizeAvatar, profileReauthMethod } from "@/lib/profile";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";

const noStore = { "cache-control": "no-store" };

function json(requestId: string, body: Record<string, unknown>, status = 200) {
  return NextResponse.json({ ...body, requestId }, { status, headers: noStore });
}

export async function GET(req: NextRequest) {
  const requestId = randomUUID();
  const user = await getSessionUser(req);
  if (!user) return json(requestId, { ok: false, error: "unauthorized" }, 401);
  try {
    const pool = getPool();
    await pool.query(
      `insert into user_account_settings (user_id, display_name)
       values ($1, $2)
       on conflict (user_id) do nothing`,
      [user.id, user.name ?? user.email?.split("@")[0] ?? "Пользователь"],
    );
    const row = (
      await pool.query<{
        first_name: string;
        last_name: string;
        display_name: string;
        job_title: string;
        bio: string;
        phone: string | null;
        pending_phone: string | null;
        phone_verification_expires_at: Date | string | null;
        locale: "ru" | "en";
        timezone: string;
        theme: "light" | "dark" | "system";
        updated_at: Date | string;
        name: string | null;
        avatar: string | null;
        email: string | null;
        password_hash: string | null;
        tg_id: string | null;
        vk_id: string | null;
      }>(
        `select settings.first_name, settings.last_name, settings.display_name,
                settings.job_title, settings.bio, settings.phone, settings.pending_phone,
                settings.phone_verification_expires_at, settings.locale, settings.timezone,
                settings.theme, settings.updated_at, account.name, account.avatar,
                account.email, account.password_hash, account.tg_id, account.vk_id
           from user_account_settings settings
           join users account on account.id = settings.user_id
          where settings.user_id = $1`,
        [user.id],
      )
    ).rows[0];
    if (!row) return json(requestId, { ok: false, error: "unavailable" }, 503);
    const phoneMode = phoneVerificationMode();
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
    return json(requestId, {
      ok: true,
      profile: {
        firstName: row.first_name,
        lastName: row.last_name,
        displayName: row.display_name || row.name || "",
        jobTitle: row.job_title,
        bio: row.bio,
        phone: row.phone ?? "",
        email: row.email ?? "",
        avatar: row.avatar ?? "",
        locale: row.locale,
        timezone: row.timezone,
        theme: row.theme,
      },
      reauthMethod: profileReauthMethod(row),
      phoneVerification: { state: phoneMode, temporary: phoneMode === "temporary" },
      pendingEmail: pendingEmail
        ? { email: pendingEmail.target_email, expiresAt: new Date(pendingEmail.expires_at).toISOString() }
        : null,
      pendingPhone: phoneMode === "temporary" && row.pending_phone && row.phone_verification_expires_at
        ? { phone: row.pending_phone, expiresAt: new Date(row.phone_verification_expires_at).toISOString() }
        : null,
      savedAt: new Date(row.updated_at).toISOString(),
    });
  } catch (error) {
    console.error("[/api/settings/account-profile] GET", {
      requestId,
      errorName: error instanceof Error ? error.name : "Error",
    });
    return json(requestId, { ok: false, error: "unavailable" }, 503);
  }
}

export async function POST(req: NextRequest) {
  const requestId = randomUUID();
  if (!hasTrustedMutationOrigin(req)) return json(requestId, { ok: false, error: "forbidden_origin" }, 403);
  const user = await getSessionUser(req);
  if (!user) return json(requestId, { ok: false, error: "unauthorized" }, 401);
  const parsed = parseAccountProfileUpdate(await readJsonBodyValue(req).catch(() => null));
  if (!parsed.ok) return json(requestId, { ok: false, error: parsed.error }, 422);
  const avatar = normalizeAvatar(parsed.value.avatar);
  if (avatar == null) return json(requestId, { ok: false, error: "bad_avatar" }, 422);
  const client = await getPool().connect().catch(() => null);
  if (!client) return json(requestId, { ok: false, error: "unavailable" }, 503);
  try {
    await client.query("begin");
    await client.query(
      `insert into user_account_settings (
         user_id, first_name, last_name, display_name, job_title, bio, locale,
         timezone, theme, updated_at
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())
       on conflict (user_id) do update
         set first_name = excluded.first_name,
             last_name = excluded.last_name,
             display_name = excluded.display_name,
             job_title = excluded.job_title,
             bio = excluded.bio,
             locale = excluded.locale,
             timezone = excluded.timezone,
             theme = excluded.theme,
             updated_at = now()`,
      [
        user.id,
        parsed.value.firstName,
        parsed.value.lastName,
        parsed.value.displayName,
        parsed.value.jobTitle,
        parsed.value.bio,
        parsed.value.locale,
        parsed.value.timezone,
        parsed.value.theme,
      ],
    );
    const updated = (
      await client.query<{ email: string | null; avatar: string | null }>(
        `update users set name = $2, avatar = nullif($3, '')
          where id = $1 returning email, avatar`,
        [user.id, parsed.value.displayName, avatar],
      )
    ).rows[0];
    await client.query("commit");
    return json(requestId, {
      ok: true,
      profile: {
        ...parsed.value,
        phone: "",
        email: updated?.email ?? "",
        avatar: updated?.avatar ?? "",
      },
      savedAt: new Date().toISOString(),
    });
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    console.error("[/api/settings/account-profile] POST", {
      requestId,
      errorName: error instanceof Error ? error.name : "Error",
    });
    return json(requestId, { ok: false, error: "unavailable" }, 503);
  } finally {
    client.release();
  }
}
