import type { Pool, PoolClient } from "pg";

import {
  requireSelectedProjectPermission,
  type ProjectPermission,
} from "@/lib/project-permissions";

type Queryable = Pick<Pool | PoolClient, "query">;

export class PublicationOperationNotFoundError extends Error {
  constructor() {
    super("publication_operation_not_found");
    this.name = "PublicationOperationNotFoundError";
  }
}

/**
 * Resolves the server-owned selected project and then scopes an untrusted route id
 * to that project. Mutations can additionally retain the legacy creator fence while
 * the lifecycle service is migrated independently.
 */
export async function authorizePublicationOperation(input: {
  db: Queryable;
  userId: number;
  operationId: number;
  permission: ProjectPermission;
  requireCreator?: boolean;
}): Promise<{ projectId: number }> {
  const membership = await requireSelectedProjectPermission(
    input.db,
    input.userId,
    input.permission,
  );
  const operation = await input.db.query<{ id: number | string }>(
    `select id
       from publication_operations
      where id = $1
        and project_id = $2
        and ($3::bigint is null or user_id = $3)
      limit 1`,
    [input.operationId, membership.projectId, input.requireCreator ? input.userId : null],
  );
  if (!operation.rows[0]) throw new PublicationOperationNotFoundError();
  return { projectId: membership.projectId };
}
