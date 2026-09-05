import "server-only";

import { getPool } from "./db";
import { requireSelectedProjectPermission } from "./project-permissions";
import type { PoolClient } from "pg";

/** Возвращает только активный канал выбранного проекта; чужой id не подменяется. */
export async function resolveLibraryChannel(userId: number, wanted?: number | null): Promise<number | null> {
  const pool = getPool();
  const membership = await requireSelectedProjectPermission(pool, userId, "project.read");
  return findLibraryChannel(pool, membership.projectId, wanted);
}

/** Call inside the admitted transaction when a write follows channel selection. */
export async function findLibraryChannel(pool: Pick<PoolClient, "query">, projectId: number, wanted?: number | null): Promise<number | null> {
  const first = await pool.query<{ id: string }>(
    `select id from channels
      where project_id = $1 and ($2::bigint is null or id = $2)
        and is_active = true and status = 'active'
      order by id limit 1 for share`,
    [projectId, wanted ?? null],
  );
  return first.rows[0] ? Number(first.rows[0].id) : null;
}
