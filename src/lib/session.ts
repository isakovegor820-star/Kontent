// Сессии Д.2. Без паролей: после подтверждения личности выдаём случайный токен,
// кладём его в cookie sid (HttpOnly + Secure + SameSite=Lax) и в таблицу sessions.
// Срок 30 дней, продлевается при активности. Выход = удаление строки в базе.

import { randomBytes } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
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
}

function expiryFromNow(): Date {
  return new Date(Date.now() + THIRTY_DAYS_S * 1000);
}

/** Создаёт сессию в базе и ставит cookie на переданный ответ. */
export async function createSession(
  res: NextResponse,
  userId: number,
  device: string | null,
): Promise<void> {
  const token = randomBytes(32).toString("hex");
  await getPool().query(
    `insert into sessions (token, user_id, expires_at, device) values ($1, $2, $3, $4)`,
    [token, userId, expiryFromNow(), device?.slice(0, 200) ?? null],
  );
  res.cookies.set(COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production", // на localhost по http Secure-cookie не ставится
    sameSite: "lax",
    path: "/",
    maxAge: THIRTY_DAYS_S,
  });
}

/** Читает cookie → живую сессию → пользователя. Продлевает срок, если он на исходе. */
export async function getSessionUser(req: NextRequest): Promise<SessionUser | null> {
  const token = req.cookies.get(COOKIE)?.value;
  if (!token) return null;

  const pool = getPool();
  const rows = await pool.query<SessionUser & { expires_at: string }>(
    `select u.id, u.tg_id, u.vk_id, u.email, u.name, u.avatar, s.expires_at
       from sessions s
       join users u on u.id = s.user_id
      where s.token = $1 and s.expires_at > now()`,
    [token],
  );
  if (rows.rowCount === 0) return null;

  const { expires_at, ...user } = rows.rows[0];
  const leftMs = new Date(expires_at).getTime() - Date.now();
  if (leftMs < RENEW_WHEN_LEFT_S * 1000) {
    await pool.query(`update sessions set expires_at = $1 where token = $2`, [
      expiryFromNow(),
      token,
    ]);
  }
  return user;
}

/** Удаляет сессию из базы и стирает cookie. */
export async function destroySession(req: NextRequest, res: NextResponse): Promise<void> {
  const token = req.cookies.get(COOKIE)?.value;
  if (token) {
    await getPool().query(`delete from sessions where token = $1`, [token]);
  }
  res.cookies.set(COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
}
