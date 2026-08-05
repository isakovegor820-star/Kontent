import "server-only";

import { getPool } from "./db";

/** Возвращает только активный канал этого пользователя; чужой id не подменяется. */
export async function resolveLibraryChannel(userId: number, wanted?: number | null): Promise<number | null> {
  const pool = getPool();
  if (wanted) {
    const own = await pool.query<{ id: string }>(
      `select id from channels where id = $1 and user_id = $2 and is_active = true`,
      [wanted, userId],
    );
    return own.rows[0] ? Number(own.rows[0].id) : null;
  }
  const first = await pool.query<{ id: string }>(
    `select id from channels where user_id = $1 and is_active = true order by id limit 1`,
    [userId],
  );
  return first.rows[0] ? Number(first.rows[0].id) : null;
}
