import { requestProjectId } from "./request-project";
import type { PoolClient } from "pg";

import { PROJECT_ROLES, roleAllows } from "./project-role-policy.mjs";
import type { ProjectRole, ProjectPermission } from "./project-role-policy.mjs";
export { PROJECT_ROLES, PROJECT_PERMISSIONS, roleAllows } from "./project-role-policy.mjs";
export type { ProjectRole, ProjectPermission } from "./project-role-policy.mjs";

type Queryable = Pick<PoolClient, "query">;

export type ActiveProjectMembership = {
  projectId: number;
  userId: number;
  role: ProjectRole;
  version: number;
};

export class ProjectAccessError extends Error {
  readonly code: "invalid_project_selector" | "membership_required" | "permission_denied";

  constructor(code: ProjectAccessError["code"]) {
    super(code);
    this.name = "ProjectAccessError";
    this.code = code;
  }
}

export async function selectedRequestProjectId(): Promise<number | null> {
  try { return await requestProjectId(); }
  catch (error) {
    if ((error as { code?: string }).code === "invalid_project_selector") throw new ProjectAccessError("invalid_project_selector");
    throw error;
  }
}

function positiveId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function isProjectRole(value: unknown): value is ProjectRole {
  return PROJECT_ROLES.includes(value as ProjectRole);
}

/**
 * Loads membership from PostgreSQL for this authorization decision. Callers must not
 * substitute a role copied from a cookie, request body, client store, or old cache.
 */
export async function getActiveProjectMembership(
  db: Queryable,
  userId: number,
  projectId: number,
): Promise<ActiveProjectMembership | null> {
  if (!positiveId(userId) || !positiveId(projectId)) {
    throw new ProjectAccessError("invalid_project_selector");
  }
  const result = await db.query<{
    project_id: number | string;
    user_id: number | string;
    role: string;
    version: number | string;
  }>(
    `select member.project_id, member.user_id, member.role, member.version
       from project_members member
       join projects project on project.id = member.project_id
      where member.project_id = $1
        and member.user_id = $2
        and member.status = 'active'
        and project.is_archived = false
      limit 1`,
    [projectId, userId],
  );
  const row = result.rows[0];
  if (!row || !isProjectRole(row.role)) return null;
  return {
    projectId: Number(row.project_id),
    userId: Number(row.user_id),
    role: row.role,
    version: Number(row.version),
  };
}

/** Rechecks active membership and role in PostgreSQL on every call. */
export async function requireProjectPermission(
  db: Queryable,
  userId: number,
  projectId: number,
  permission: ProjectPermission,
  options: { allowProjectSelection?: boolean } = {},
): Promise<ActiveProjectMembership> {
  const expectedProjectId = await selectedRequestProjectId();
  if (!options.allowProjectSelection && expectedProjectId !== null && expectedProjectId !== projectId) {
    throw new ProjectAccessError("invalid_project_selector");
  }
  const membership = await getActiveProjectMembership(db, userId, projectId);
  if (!membership) throw new ProjectAccessError("membership_required");
  if (!roleAllows(membership.role, permission)) {
    throw new ProjectAccessError("permission_denied");
  }
  return membership;
}

/**
 * Resolves the request-bound project and rechecks its current membership.
 * Background/legacy callers without a selector retain the server preference.
 * This is the normal guard for routes that do not implement the dedicated switcher.
 */
export async function requireSelectedProjectPermission(
  db: Queryable,
  userId: number,
  permission: ProjectPermission,
): Promise<ActiveProjectMembership> {
  if (!positiveId(userId)) throw new ProjectAccessError("invalid_project_selector");
  const expectedProjectId = await selectedRequestProjectId();
  if (expectedProjectId !== null) return requireProjectPermission(db, userId, expectedProjectId, permission);
  const result = await db.query<{
    project_id: number | string;
    user_id: number | string;
    role: string;
    version: number | string;
  }>(
    `select member.project_id, member.user_id, member.role, member.version
       from user_project_preferences preference
       join project_members member
         on member.project_id = preference.selected_project_id
        and member.user_id = preference.user_id
        and member.status = 'active'
       join projects project
         on project.id = member.project_id
        and project.is_archived = false
      where preference.user_id = $1
      limit 1`,
    [userId],
  );
  const row = result.rows[0];
  if (!row || !isProjectRole(row.role)) {
    throw new ProjectAccessError("membership_required");
  }
  const membership: ActiveProjectMembership = {
    projectId: Number(row.project_id),
    userId: Number(row.user_id),
    role: row.role,
    version: Number(row.version),
  };
  if (!roleAllows(membership.role, permission)) {
    throw new ProjectAccessError("permission_denied");
  }
  return membership;
}
