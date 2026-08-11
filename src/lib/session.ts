// Сессии Д.2. Без паролей: после подтверждения личности выдаём случайный токен,
// кладём его в cookie sid (HttpOnly + Secure + SameSite=Lax) и в таблицу sessions.
// Срок 30 дней, продлевается при активности. Выход = удаление строки в базе.

import { randomBytes } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getPool } from "./db";

const COOKIE = "sid";
const THIRTY_DAYS_S = 60 * 60 * 24 * 30;
// Продлеваем срок, только если осталось меньше этого — чтобы не писать в базу на каждый запрос.
const RENEW_WHEN_LEFT_S = 60 * 60 * 24 * 25;

export interface SessionUser {
  id: number;
  tg_id: number | null;
  vk_id: number | null;
  email: string | null;
  name: string | null;
  avatar: string | null;
  onboarding_completed_at: string | null;
}

function expiryFromNow(): Date {
  return new Date(Date.now() + THIRTY_DAYS_S * 1000);
}

function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: THIRTY_DAYS_S,
  };
}

/** Clear the browser session after a password reset; DB sessions are revoked separately. */
export function clearSessionCookie(res: NextResponse): void {
  res.cookies.set(COOKIE, "", { ...sessionCookieOptions(), maxAge: 0 });
}

/** Создаёт сессию в базе и ставит cookie на переданный ответ. */
export async function createSession(
  res: NextResponse,
  userId: number,
  device: string | null,
  expectedCredentialEpoch?: number,
): Promise<boolean> {
  const token = randomBytes(32).toString("hex");
  const inserted = await getPool().query(
    `insert into sessions (token, user_id, expires_at, device, credential_epoch)
     select $1, u.id, $3, $4, u.credential_epoch
       from users u
      where u.id = $2 and ($5::bigint is null or u.credential_epoch = $5)
     returning token`,
    [
      token,
      userId,
      expiryFromNow(),
      device?.slice(0, 200) ?? null,
      expectedCredentialEpoch ?? null,
    ],
  );
  if (inserted.rowCount !== 1) return false;
  res.cookies.set(COOKIE, token, sessionCookieOptions());
  return true;
}

/** Читает cookie → живую сессию → пользователя. Продлевает срок, если он на исходе. */
export async function getSessionUser(req: NextRequest): Promise<SessionUser | null> {
  const token = req.cookies.get(COOKIE)?.value;
  if (!token) return null;

  const pool = getPool();
  const rows = await pool.query<SessionUser & { expires_at: string }>(
    `select u.id, u.tg_id, u.vk_id, u.email, u.name, u.avatar,
            u.onboarding_completed_at, s.expires_at
       from sessions s
       join users u on u.id = s.user_id
      where s.token = $1 and s.expires_at > now()
        and s.credential_epoch = u.credential_epoch`,
    [token],
  );
  if (rows.rowCount === 0) return null;

  const { expires_at, ...rawUser } = rows.rows[0];
  // `pg` returns PostgreSQL bigint values as strings at runtime. Keep the public
  // session contract numeric so account-scoped caches and persistence never compare
  // `"1"` with `1` and accidentally reject valid data.
  const user: SessionUser = {
    ...rawUser,
    id: Number(rawUser.id),
    tg_id: rawUser.tg_id == null ? null : Number(rawUser.tg_id),
    vk_id: rawUser.vk_id == null ? null : Number(rawUser.vk_id),
  };
  if (!Number.isSafeInteger(user.id) || user.id <= 0) return null;
  const leftMs = new Date(expires_at).getTime() - Date.now();
  if (leftMs < RENEW_WHEN_LEFT_S * 1000) {
    await pool.query(`update sessions set expires_at = $1 where token = $2`, [
      expiryFromNow(),
      token,
    ]);
    // Sliding session обязана продлевать и серверную строку, и браузерную cookie.
    // Иначе БД жила ещё 30 дней, а cookie исчезала по первоначальному сроку.
    (await cookies()).set(COOKIE, token, sessionCookieOptions());
  }
  return user;
}

/** Удаляет сессию из базы и стирает cookie. */
export async function destroySession(req: NextRequest, res: NextResponse): Promise<void> {
  const token = req.cookies.get(COOKIE)?.value;
  try {
    if (token) {
      await getPool().query(`delete from sessions where token = $1`, [token]);
    }
  } finally {
    // Local logout must not depend on PostgreSQL availability. The server-side row may
    // be cleaned up later, but this browser must stop presenting the credential now.
    clearSessionCookie(res);
  }
}
