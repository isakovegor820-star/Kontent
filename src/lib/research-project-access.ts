import type { Pool, PoolClient } from "pg";
import type { ProjectPermission } from "./project-permissions";
import { withSelectedProjectPermission } from "./selected-project-transaction";

export async function withResearchProject(pool: Pool, userId: number, permission: ProjectPermission,
  action: (client: PoolClient, projectId: number, afterCommit: (task: (pool: Pool) => Promise<Response | void>) => void) => Promise<Response>) {
  const committedTasks: Array<(pool: Pool) => Promise<Response | void>> = [];
  let result = await withSelectedProjectPermission(pool, userId, permission,
    (client, membership) => action(client, membership.projectId, (task) => committedTasks.push(task)));
  // A fast consumer must never see an enqueued row before its transaction commits.
  for (const task of committedTasks) {
    const override = await task(pool);
    if (override !== undefined) result = override;
  }
  return result;
}

/** Channel identity stays in the admitted project for the whole operation. */
export async function researchChannel(client: PoolClient, projectId: number, wanted?: number | null, write = false) {
  const selected = await client.query<{ id: string }>(
    `select id from channels where project_id=$1 and network='tg' and is_active=true
       and status='active' and ($2::bigint is null or id=$2)
     order by id limit 1 for ${write ? "update" : "share"}`,
    [projectId, wanted ?? null],
  );
  return selected.rows[0] ? Number(selected.rows[0].id) : null;
}
