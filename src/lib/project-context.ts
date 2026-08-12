import type { Pool, PoolClient } from "pg";

import {
  ProjectAccessError,
  PROJECT_ROLES,
  requireProjectPermission,
  type ProjectRole,
} from "./project-permissions";

type TransactionPool = Pick<Pool, "connect">;

export type ProjectContext = {
  projectId: number;
  name: string;
  timezone: string;
  role: ProjectRole;
  version: number;
  personal: boolean;
};

export class ProjectMembershipMutationError extends Error {
  readonly code: "member_not_found" | "version_conflict" | "last_owner";

  constructor(code: ProjectMembershipMutationError["code"]) {
    super(code);
    this.name = "ProjectMembershipMutationError";
    this.code = code;
  }
}

function positiveId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function isProjectRole(value: unknown): value is ProjectRole {
  return PROJECT_ROLES.includes(value as ProjectRole);
}

async function withTransaction<T>(pool: TransactionPool, task: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await task(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Transaction-local primitive used by every registration path. The unique personal
 * owner key makes it safe under retries and concurrent session self-healing.
 */
export async function ensureDefaultPersonalProjectInTransaction(
  client: Pick<PoolClient, "query">,
  userId: number,
): Promise<number> {
  if (!positiveId(userId)) throw new ProjectAccessError("invalid_project_selector");

  const inserted = await client.query<{ id: number | string }>(
    `insert into projects (name, timezone, created_by_user_id, personal_owner_user_id)
     select 'Личный проект', 'UTC', user_row.id, user_row.id
       from users user_row
      where user_row.id = $1
     on conflict (personal_owner_user_id) do nothing
     returning id`,
    [userId],
  );
  let projectId = inserted.rows[0] ? Number(inserted.rows[0].id) : 0;
  if (!positiveId(projectId)) {
    const existing = await client.query<{ id: number | string }>(
      `select id from projects where personal_owner_user_id = $1 limit 1`,
      [userId],
    );
    projectId = Number(existing.rows[0]?.id ?? 0);
  }
  if (!positiveId(projectId)) throw new Error("personal_project_creation_failed");

  await client.query(
    `insert into project_members (project_id, user_id, role, status)
     values ($1, $2, 'owner', 'active')
     on conflict (project_id, user_id) do update
       set role = 'owner', status = 'active', revoked_at = null,
           version = project_members.version + 1, updated_at = now()
     where project_members.role <> 'owner'
        or project_members.status <> 'active'
        or project_members.revoked_at is not null`,
    [projectId, userId],
  );
  await client.query(
    `insert into user_project_preferences (user_id, selected_project_id)
     values ($1, $2)
     on conflict (user_id) do update
       set selected_project_id = case
             when exists (
               select 1 from project_members active_member
                where active_member.project_id = user_project_preferences.selected_project_id
                  and active_member.user_id = user_project_preferences.user_id
                  and active_member.status = 'active'
             ) then user_project_preferences.selected_project_id
             else excluded.selected_project_id
           end,
           updated_at = case
             when exists (
               select 1 from project_members active_member
                where active_member.project_id = user_project_preferences.selected_project_id
                  and active_member.user_id = user_project_preferences.user_id
                  and active_member.status = 'active'
             ) then user_project_preferences.updated_at
             else now()
           end`,
    [userId, projectId],
  );
  await client.query(
    `insert into audit_events (
       project_id, actor_user_id, action, entity_type, entity_id,
       after_version, safe_data, idempotency_key
     ) values (
       $1::bigint, $2::bigint, 'project.created', 'project', ($1::bigint)::text,
       1, '{"kind":"personal","source":"registration"}'::jsonb,
       'bootstrap:personal-project:' || ($1::bigint)::text
     )
     on conflict (project_id, idempotency_key) where idempotency_key is not null do nothing`,
    [projectId, userId],
  );
  return projectId;
}

export function ensureDefaultPersonalProject(pool: TransactionPool, userId: number): Promise<number> {
  return withTransaction(pool, (client) => ensureDefaultPersonalProjectInTransaction(client, userId));
}

async function readSelectedProject(client: Pick<PoolClient, "query">, userId: number): Promise<ProjectContext | null> {
  const result = await client.query<{
    project_id: number | string;
    name: string;
    timezone: string;
    role: string;
    version: number | string;
    personal: boolean;
  }>(
    `select project.id as project_id, project.name, project.timezone,
            member.role, member.version,
            (project.personal_owner_user_id = $1) as personal
       from user_project_preferences preference
       join project_members member
         on member.project_id = preference.selected_project_id
        and member.user_id = preference.user_id
        and member.status = 'active'
       join projects project
         on project.id = preference.selected_project_id
        and project.is_archived = false
      where preference.user_id = $1
      limit 1`,
    [userId],
  );
  const row = result.rows[0];
  if (!row || !isProjectRole(row.role)) return null;
  return {
    projectId: Number(row.project_id),
    name: row.name,
    timezone: row.timezone,
    role: row.role,
    version: Number(row.version),
    personal: row.personal === true,
  };
}

/** Reads server-owned selection; repairs only a missing/stale selection. */
export async function getSelectedProjectContext(
  pool: TransactionPool,
  userId: number,
): Promise<ProjectContext> {
  if (!positiveId(userId)) throw new ProjectAccessError("invalid_project_selector");
  return withTransaction(pool, async (client) => {
    const selected = await readSelectedProject(client, userId);
    if (selected) return selected;
    await ensureDefaultPersonalProjectInTransaction(client, userId);
    const repaired = await readSelectedProject(client, userId);
    if (!repaired) throw new Error("project_context_missing");
    return repaired;
  });
}

/**
 * Dedicated selector primitive. projectId is untrusted client input until this
 * transaction verifies a current active membership and stores the selection.
 */
export async function selectProjectForUser(
  pool: TransactionPool,
  userId: number,
  projectId: number,
): Promise<ProjectContext> {
  if (!positiveId(userId) || !positiveId(projectId)) {
    throw new ProjectAccessError("invalid_project_selector");
  }
  return withTransaction(pool, async (client) => {
    await requireProjectPermission(client, userId, projectId, "project.read");
    await client.query(
      `insert into user_project_preferences (user_id, selected_project_id)
       values ($1, $2)
       on conflict (user_id) do update
         set selected_project_id = excluded.selected_project_id, updated_at = now()`,
      [userId, projectId],
    );
    const selected = await readSelectedProject(client, userId);
    if (!selected || selected.projectId !== projectId) throw new Error("project_selection_failed");
    return selected;
  });
}

async function lockMemberAndOwners(
  client: PoolClient,
  projectId: number,
  memberUserId: number,
): Promise<{
  target: { role: ProjectRole; version: number; status: string };
  activeOwnerIds: number[];
}> {
  // Lock the complete owner set and the target in one deterministic order. Two
  // concurrent owner demotions therefore serialize instead of each locking its own
  // target first and deadlocking while trying to inspect the other owner.
  const lockedMembers = await client.query<{
    user_id: number | string;
    role: string;
    version: number | string;
    status: string;
  }>(
    `select user_id, role, version, status
       from project_members
      where project_id = $1
        and (user_id = $2 or (role = 'owner' and status = 'active'))
      order by user_id
      for update`,
    [projectId, memberUserId],
  );
  const targetRow = lockedMembers.rows.find((row) => Number(row.user_id) === memberUserId);
  if (!targetRow || !isProjectRole(targetRow.role) || targetRow.status !== "active") {
    throw new ProjectMembershipMutationError("member_not_found");
  }
  return {
    target: { role: targetRow.role, version: Number(targetRow.version), status: targetRow.status },
    activeOwnerIds: lockedMembers.rows
      .filter((row) => row.role === "owner" && row.status === "active")
      .map((row) => Number(row.user_id)),
  };
}

export async function changeProjectMemberRole(input: {
  pool: TransactionPool;
  actorUserId: number;
  projectId: number;
  memberUserId: number;
  role: ProjectRole;
  expectedVersion: number;
  requestId?: string | null;
}): Promise<{ version: number; role: ProjectRole }> {
  if (!isProjectRole(input.role)) throw new ProjectAccessError("permission_denied");
  return withTransaction(input.pool, async (client) => {
    await requireProjectPermission(client, input.actorUserId, input.projectId, "members.manage");
    const locked = await lockMemberAndOwners(client, input.projectId, input.memberUserId);
    if (locked.target.version !== input.expectedVersion) {
      throw new ProjectMembershipMutationError("version_conflict");
    }
    if (locked.target.role === "owner" && input.role !== "owner" && locked.activeOwnerIds.length <= 1) {
      throw new ProjectMembershipMutationError("last_owner");
    }
    const nextVersion = locked.target.version + 1;
    await client.query(
      `update project_members
          set role = $3, version = $4, updated_at = now()
        where project_id = $1 and user_id = $2 and status = 'active'`,
      [input.projectId, input.memberUserId, input.role, nextVersion],
    );
    await client.query(
      `insert into audit_events (
         project_id, actor_user_id, action, entity_type, entity_id,
         before_version, after_version, safe_data, request_id
       ) values ($1, $2, 'project.member.role_changed', 'project_member', $3::text,
                 $4, $5, jsonb_build_object('from_role', $6::text, 'to_role', $7::text), $8)`,
      [
        input.projectId,
        input.actorUserId,
        input.memberUserId,
        locked.target.version,
        nextVersion,
        locked.target.role,
        input.role,
        input.requestId?.slice(0, 128) || null,
      ],
    );
    return { version: nextVersion, role: input.role };
  });
}

export async function revokeProjectMember(input: {
  pool: TransactionPool;
  actorUserId: number;
  projectId: number;
  memberUserId: number;
  expectedVersion: number;
  requestId?: string | null;
}): Promise<{ version: number }> {
  return withTransaction(input.pool, async (client) => {
    await requireProjectPermission(client, input.actorUserId, input.projectId, "members.manage");
    const locked = await lockMemberAndOwners(client, input.projectId, input.memberUserId);
    if (locked.target.version !== input.expectedVersion) {
      throw new ProjectMembershipMutationError("version_conflict");
    }
    if (locked.target.role === "owner" && locked.activeOwnerIds.length <= 1) {
      throw new ProjectMembershipMutationError("last_owner");
    }
    const nextVersion = locked.target.version + 1;
    await client.query(
      `update project_members
          set status = 'revoked', revoked_at = now(), version = $3, updated_at = now()
        where project_id = $1 and user_id = $2 and status = 'active'`,
      [input.projectId, input.memberUserId, nextVersion],
    );
    await client.query(
      `update user_project_preferences preference
          set selected_project_id = personal.id, updated_at = now()
         from projects personal
        where preference.user_id = $1
          and preference.selected_project_id = $2
          and personal.personal_owner_user_id = preference.user_id`,
      [input.memberUserId, input.projectId],
    );
    await client.query(
      `insert into audit_events (
         project_id, actor_user_id, action, entity_type, entity_id,
         before_version, after_version, safe_data, request_id
       ) values ($1, $2, 'project.member.revoked', 'project_member', $3::text,
                 $4, $5, jsonb_build_object('role', $6::text), $7)`,
      [
        input.projectId,
        input.actorUserId,
        input.memberUserId,
        locked.target.version,
        nextVersion,
        locked.target.role,
        input.requestId?.slice(0, 128) || null,
      ],
    );
    return { version: nextVersion };
  });
}
