import "server-only";

import { getPool } from "./db";
import { requireSelectedProjectPermission } from "./project-permissions";

/** Возвращает только активный канал выбранного проекта; чужой id не подменяется. */
export async function resolveLibraryChannel(userId: number, wanted?: number | null): Promise<number | null> {
  const pool = getPool();
  const membership = await requireSelectedProjectPermission(pool, userId, "project.read");
  if (wanted) {
    const own = await pool.query<{ id: string }>(
      `select id from channels
        where id = $1 and user_id = $2 and project_id = $3
          and is_active = true and status = 'active'`,
      [wanted, userId, membership.projectId],
    );
    return own.rows[0] ? Number(own.rows[0].id) : null;
  }
  const first = await pool.query<{ id: string }>(
    `select id from channels
      where user_id = $1 and project_id = $2
        and is_active = true and status = 'active'
      order by id limit 1`,
    [userId, membership.projectId],
  );
  return first.rows[0] ? Number(first.rows[0].id) : null;
}
