import { createHash, randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";

import {
  PROJECT_ROLES,
  ProjectAccessError,
  requireProjectPermission,
  type ProjectRole,
} from "./project-permissions";
import { normalizeIdempotencyKey } from "./publication-idempotency";

export const INVITABLE_PROJECT_ROLES = ["author", "approver", "publisher"] as const;
export type InvitableProjectRole = (typeof INVITABLE_PROJECT_ROLES)[number];

export type ProjectSummary = {
  id: number;
  name: string;
  timezone: string;
  role: ProjectRole;
  version: number;
  personal: boolean;
  selected: boolean;
  createdAt: string;
};

export type ProjectMemberSummary = {
  userId: number;
  name: string | null;
  email: string | null;
  avatar: string | null;
  role: ProjectRole;
  version: number;
  joinedAt: string;
};

export type ProjectInvitationSummary = {
  id: number;
  email: string;
  role: InvitableProjectRole;
  status: "pending" | "expired" | "accepted" | "revoked";
  expiresAt: string;
  createdAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
};

export class ProjectTeamError extends Error {
  readonly code:
    | "invalid_name"
    | "invalid_timezone"
    | "invalid_email"
    | "invalid_role"
    | "invalid_ttl"
    | "invalid_token"
    | "invalid_idempotency_key"
    | "idempotency_conflict"
    | "invitation_pending"
    | "invitation_not_found"
    | "invitation_expired"
    | "invitation_revoked"
    | "invitation_used"
    | "email_mismatch"
    | "already_member";

  constructor(code: ProjectTeamError["code"]) {
    super(code);
    this.name = "ProjectTeamError";
    this.code = code;
  }
}

function positiveId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function isProjectRole(value: unknown): value is ProjectRole {
  return PROJECT_ROLES.includes(value as ProjectRole);
}

function isInvitableRole(value: unknown): value is InvitableProjectRole {
  return INVITABLE_PROJECT_ROLES.includes(value as InvitableProjectRole);
}

async function withTransaction<T>(pool: Pick<Pool, "connect">, task: (client: PoolClient) => Promise<T>): Promise<T> {
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

export function normalizeProjectName(value: unknown): string {
  if (typeof value !== "string") throw new ProjectTeamError("invalid_name");
  const name = value.trim().replace(/\s+/g, " ");
  if (name.length < 1 || name.length > 160) throw new ProjectTeamError("invalid_name");
  return name;
}

export function normalizeProjectTimezone(value: unknown): string {
  const timezone = value == null ? "UTC" : typeof value === "string" ? value.trim() : "";
  if (!timezone || timezone.length > 80) throw new ProjectTeamError("invalid_timezone");
  try {
    new Intl.DateTimeFormat("ru-RU", { timeZone: timezone }).format(new Date());
  } catch {
    throw new ProjectTeamError("invalid_timezone");
  }
  return timezone;
}

export function normalizeInvitationEmail(value: unknown): string {
  if (typeof value !== "string") throw new ProjectTeamError("invalid_email");
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ProjectTeamError("invalid_email");
  }
  return email;
}

export function parseInvitableRole(value: unknown): InvitableProjectRole {
  if (!isInvitableRole(value)) throw new ProjectTeamError("invalid_role");
  return value;
}

export function parseInvitationTtlDays(value: unknown): number {
  if (value == null) return 7;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 30) {
    throw new ProjectTeamError("invalid_ttl");
  }
  return value;
}

export function hashInvitationToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export async function listProjectsForUser(pool: Pick<Pool, "query">, userId: number): Promise<ProjectSummary[]> {
  if (!positiveId(userId)) throw new ProjectAccessError("invalid_project_selector");
  const result = await pool.query<{
    id: number | string;
    name: string;
    timezone: string;
    role: string;
    version: number | string;
    personal: boolean;
    selected: boolean;
    created_at: string | Date;
  }>(
    `select project.id, project.name, project.timezone, member.role, member.version,
            (project.personal_owner_user_id = $1) as personal,
            (preference.selected_project_id = project.id) as selected,
            project.created_at
       from project_members member
       join projects project on project.id = member.project_id and project.is_archived = false
       left join user_project_preferences preference on preference.user_id = member.user_id
      where member.user_id = $1 and member.status = 'active'
      order by (preference.selected_project_id = project.id) desc, project.name, project.id`,
    [userId],
  );
  return result.rows.flatMap((row) => isProjectRole(row.role) ? [{
    id: Number(row.id),
    name: row.name,
    timezone: row.timezone,
    role: row.role,
    version: Number(row.version),
    personal: row.personal === true,
    selected: row.selected === true,
    createdAt: new Date(row.created_at).toISOString(),
  }] : []);
}

export async function createProject(input: {
  pool: Pick<Pool, "connect">;
  actorUserId: number;
  name: unknown;
  timezone?: unknown;
  idempotencyKey?: unknown;
  requestId?: string | null;
}): Promise<ProjectSummary> {
  if (!positiveId(input.actorUserId)) throw new ProjectAccessError("invalid_project_selector");
  const name = normalizeProjectName(input.name);
  const timezone = normalizeProjectTimezone(input.timezone);
  const suppliedIdempotencyKey = input.idempotencyKey == null
    ? null
    : normalizeIdempotencyKey(input.idempotencyKey);
  if (input.idempotencyKey != null && !suppliedIdempotencyKey) {
    throw new ProjectTeamError("invalid_idempotency_key");
  }
  const idempotencyKey = suppliedIdempotencyKey ? `project:create:${suppliedIdempotencyKey}` : null;
  const requestFingerprint = createHash("sha256")
    .update(JSON.stringify([name, timezone]), "utf8")
    .digest("hex");
  return withTransaction(input.pool, async (client) => {
    const actor = await client.query(`select id from users where id = $1 for update`, [input.actorUserId]);
    if (!actor.rowCount) throw new ProjectAccessError("invalid_project_selector");
    if (idempotencyKey) {
      const replay = await client.query<{
        id: number | string;
        name: string;
        timezone: string;
        project_version: number | string;
        member_version: number | string;
        role: string;
        selected: boolean;
        fingerprint: string | null;
        created_at: string | Date;
      }>(
        `select project.id, project.name, project.timezone,
                project.version as project_version, member.version as member_version,
                member.role, (preference.selected_project_id = project.id) as selected,
                event.safe_data->>'fingerprint' as fingerprint,
                project.created_at
           from audit_events event
           join projects project on project.id = event.project_id and project.is_archived = false
           join project_members member
             on member.project_id = project.id and member.user_id = $1 and member.status = 'active'
           left join user_project_preferences preference on preference.user_id = $1
          where event.actor_user_id = $1
            and event.action = 'project.created'
            and event.idempotency_key = $2
          order by event.id desc
          limit 1`,
        [input.actorUserId, idempotencyKey],
      );
      const previous = replay.rows[0];
      if (previous && isProjectRole(previous.role)) {
        if (previous.fingerprint !== requestFingerprint) {
          throw new ProjectTeamError("idempotency_conflict");
        }
        return {
          id: Number(previous.id),
          name: previous.name,
          timezone: previous.timezone,
          role: previous.role,
          version: Number(previous.member_version),
          personal: false,
          selected: previous.selected === true,
          createdAt: new Date(previous.created_at).toISOString(),
        };
      }
    }
    const created = await client.query<{
      id: number | string;
      name: string;
      timezone: string;
      version: number | string;
      created_at: string | Date;
    }>(
      `insert into projects (name, timezone, created_by_user_id)
       select $2, $3, user_row.id from users user_row where user_row.id = $1
       returning id, name, timezone, version, created_at`,
      [input.actorUserId, name, timezone],
    );
    const row = created.rows[0];
    if (!row) throw new Error("project_creation_failed");
    const projectId = Number(row.id);
    await client.query(
      `insert into project_members (project_id, user_id, role, status)
       values ($1, $2, 'owner', 'active')`,
      [projectId, input.actorUserId],
    );
    await client.query(
      `insert into user_project_preferences (user_id, selected_project_id)
       values ($1, $2)
       on conflict (user_id) do update
         set selected_project_id = excluded.selected_project_id, updated_at = now()`,
      [input.actorUserId, projectId],
    );
    await client.query(
      `insert into audit_events (
         project_id, actor_user_id, action, entity_type, entity_id,
         after_version, safe_data, request_id, idempotency_key
       ) values ($1, $2, 'project.created', 'project', $1::text,
                 $3, jsonb_build_object('kind', 'team', 'fingerprint', $6::text), $4, $5)`,
      [
        projectId,
        input.actorUserId,
        Number(row.version),
        input.requestId?.slice(0, 128) || null,
        idempotencyKey,
        requestFingerprint,
      ],
    );
    return {
      id: projectId,
      name: row.name,
      timezone: row.timezone,
      role: "owner",
      version: Number(row.version),
      personal: false,
      selected: true,
      createdAt: new Date(row.created_at).toISOString(),
    };
  });
}

export async function listProjectMembers(input: {
  pool: Pick<Pool, "query">;
  actorUserId: number;
  projectId: number;
}): Promise<ProjectMemberSummary[]> {
  await requireProjectPermission(input.pool as never, input.actorUserId, input.projectId, "project.read");
  const result = await input.pool.query<{
    user_id: number | string;
    name: string | null;
    email: string | null;
    avatar: string | null;
    role: string;
    version: number | string;
    joined_at: string | Date;
  }>(
    `select member.user_id, user_row.name, user_row.email, user_row.avatar,
            member.role, member.version, member.joined_at
       from project_members member
       join users user_row on user_row.id = member.user_id
      where member.project_id = $1 and member.status = 'active'
      order by case member.role when 'owner' then 0 when 'approver' then 1
                  when 'publisher' then 2 else 3 end,
               coalesce(user_row.name, user_row.email, member.user_id::text)`,
    [input.projectId],
  );
  return result.rows.flatMap((row) => isProjectRole(row.role) ? [{
    userId: Number(row.user_id),
    name: row.name,
    email: row.email,
    avatar: row.avatar,
    role: row.role,
    version: Number(row.version),
    joinedAt: new Date(row.joined_at).toISOString(),
  }] : []);
}

export async function listProjectInvitations(input: {
  pool: Pick<Pool, "query">;
  actorUserId: number;
  projectId: number;
}): Promise<ProjectInvitationSummary[]> {
  await requireProjectPermission(input.pool as never, input.actorUserId, input.projectId, "members.manage");
  const result = await input.pool.query<{
    id: number | string;
    email: string;
    role: string;
    status: ProjectInvitationSummary["status"];
    expires_at: string | Date;
    created_at: string | Date;
    accepted_at: string | Date | null;
    revoked_at: string | Date | null;
  }>(
    `select id, email, role,
            case when accepted_at is not null then 'accepted'
                 when revoked_at is not null then 'revoked'
                 when expires_at <= now() then 'expired'
                 else 'pending' end as status,
            expires_at, created_at, accepted_at, revoked_at
       from project_invitations
      where project_id = $1
      order by created_at desc, id desc`,
    [input.projectId],
  );
  return result.rows.flatMap((row) => isInvitableRole(row.role) ? [{
    id: Number(row.id),
    email: row.email,
    role: row.role,
    status: row.status,
    expiresAt: new Date(row.expires_at).toISOString(),
    createdAt: new Date(row.created_at).toISOString(),
    acceptedAt: row.accepted_at ? new Date(row.accepted_at).toISOString() : null,
    revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : null,
  }] : []);
}

export async function createProjectInvitation(input: {
  pool: Pick<Pool, "connect">;
  actorUserId: number;
  projectId: number;
  email: unknown;
  role: unknown;
  ttlDays?: unknown;
  requestId?: string | null;
}): Promise<{ invitation: ProjectInvitationSummary; token: string }> {
  const email = normalizeInvitationEmail(input.email);
  const role = parseInvitableRole(input.role);
  const ttlDays = parseInvitationTtlDays(input.ttlDays);
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashInvitationToken(token);
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);

  const invitation = await withTransaction(input.pool, async (client) => {
    await requireProjectPermission(client, input.actorUserId, input.projectId, "members.manage");
    await client.query(`select id from projects where id = $1 and is_archived = false for update`, [input.projectId]);
    const duplicate = await client.query(
      `select id from project_invitations
        where project_id = $1 and email = $2
          and accepted_at is null and revoked_at is null and expires_at > now()
        limit 1`,
      [input.projectId, email],
    );
    if (duplicate.rowCount) throw new ProjectTeamError("invitation_pending");
    const existingMember = await client.query(
      `select 1 from project_members member
        join users user_row on user_row.id = member.user_id
       where member.project_id = $1 and member.status = 'active' and lower(btrim(user_row.email)) = $2
       limit 1`,
      [input.projectId, email],
    );
    if (existingMember.rowCount) throw new ProjectTeamError("already_member");
    const inserted = await client.query<{
      id: number | string;
      expires_at: string | Date;
      created_at: string | Date;
    }>(
      `insert into project_invitations (
         project_id, email, role, token_hash, invited_by_user_id, expires_at
       ) values ($1, $2, $3, $4, $5, $6)
       returning id, expires_at, created_at`,
      [input.projectId, email, role, tokenHash, input.actorUserId, expiresAt],
    );
    const row = inserted.rows[0];
    if (!row) throw new Error("invitation_creation_failed");
    await client.query(
      `insert into audit_events (
         project_id, actor_user_id, action, entity_type, entity_id,
         safe_data, request_id
       ) values ($1, $2, 'project.invitation.created', 'project_invitation', $3::text,
                 jsonb_build_object('role', $4::text, 'ttl_days', $5::int), $6)`,
      [
        input.projectId,
        input.actorUserId,
        Number(row.id),
        role,
        ttlDays,
        input.requestId?.slice(0, 128) || null,
      ],
    );
    return {
      id: Number(row.id),
      email,
      role,
      status: "pending" as const,
      expiresAt: new Date(row.expires_at).toISOString(),
      createdAt: new Date(row.created_at).toISOString(),
      acceptedAt: null,
      revokedAt: null,
    };
  });
  return { invitation, token };
}

export async function revokeProjectInvitation(input: {
  pool: Pick<Pool, "connect">;
  actorUserId: number;
  projectId: number;
  invitationId: number;
  requestId?: string | null;
}): Promise<{ replayed: boolean }> {
  if (!positiveId(input.invitationId)) throw new ProjectTeamError("invitation_not_found");
  return withTransaction(input.pool, async (client) => {
    await requireProjectPermission(client, input.actorUserId, input.projectId, "members.manage");
    const result = await client.query<{
      id: number | string;
      role: string;
      accepted_at: string | null;
      revoked_at: string | null;
    }>(
      `select id, role, accepted_at, revoked_at
         from project_invitations
        where id = $1 and project_id = $2
        for update`,
      [input.invitationId, input.projectId],
    );
    const row = result.rows[0];
    if (!row) throw new ProjectTeamError("invitation_not_found");
    if (row.accepted_at) throw new ProjectTeamError("invitation_used");
    if (row.revoked_at) return { replayed: true };
    await client.query(`update project_invitations set revoked_at = now() where id = $1`, [input.invitationId]);
    await client.query(
      `insert into audit_events (
         project_id, actor_user_id, action, entity_type, entity_id,
         safe_data, request_id
       ) values ($1, $2, 'project.invitation.revoked', 'project_invitation', $3::text,
                 jsonb_build_object('role', $4::text), $5)`,
      [
        input.projectId,
        input.actorUserId,
        input.invitationId,
        isInvitableRole(row.role) ? row.role : "author",
        input.requestId?.slice(0, 128) || null,
      ],
    );
    return { replayed: false };
  });
}

export async function acceptProjectInvitation(input: {
  pool: Pick<Pool, "connect">;
  actorUserId: number;
  token: unknown;
  requestId?: string | null;
}): Promise<{ projectId: number; role: InvitableProjectRole }> {
  if (typeof input.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(input.token)) {
    throw new ProjectTeamError("invalid_token");
  }
  const tokenHash = hashInvitationToken(input.token);
  return withTransaction(input.pool, async (client) => {
    const invitationResult = await client.query<{
      id: number | string;
      project_id: number | string;
      email: string;
      role: string;
      expires_at: string | Date;
      accepted_at: string | null;
      revoked_at: string | null;
    }>(
      `select invitation.id, invitation.project_id, invitation.email, invitation.role,
              invitation.expires_at, invitation.accepted_at, invitation.revoked_at
         from project_invitations invitation
         join projects project on project.id = invitation.project_id and project.is_archived = false
        where invitation.token_hash = $1
        for update`,
      [tokenHash],
    );
    const invitation = invitationResult.rows[0];
    if (!invitation || !isInvitableRole(invitation.role)) {
      throw new ProjectTeamError("invitation_not_found");
    }
    if (invitation.accepted_at) throw new ProjectTeamError("invitation_used");
    if (invitation.revoked_at) throw new ProjectTeamError("invitation_revoked");
    if (new Date(invitation.expires_at).getTime() <= Date.now()) {
      throw new ProjectTeamError("invitation_expired");
    }
    const account = await client.query<{ email: string | null }>(
      `select lower(btrim(email)) as email from users where id = $1 for update`,
      [input.actorUserId],
    );
    const accountEmail = account.rows[0]?.email;
    if (!accountEmail || accountEmail !== invitation.email) {
      throw new ProjectTeamError("email_mismatch");
    }
    const projectId = Number(invitation.project_id);
    const member = await client.query<{ status: string; version: number | string }>(
      `select status, version from project_members
        where project_id = $1 and user_id = $2 for update`,
      [projectId, input.actorUserId],
    );
    if (member.rows[0]?.status === "active") throw new ProjectTeamError("already_member");
    if (member.rows[0]) {
      await client.query(
        `update project_members
            set role = $3, status = 'active', revoked_at = null,
                version = version + 1, joined_at = now(), updated_at = now()
          where project_id = $1 and user_id = $2`,
        [projectId, input.actorUserId, invitation.role],
      );
    } else {
      await client.query(
        `insert into project_members (project_id, user_id, role, status)
         values ($1, $2, $3, 'active')`,
        [projectId, input.actorUserId, invitation.role],
      );
    }
    const accepted = await client.query(
      `update project_invitations
          set accepted_at = now(), accepted_by_user_id = $2
        where id = $1 and accepted_at is null and revoked_at is null and expires_at > now()`,
      [Number(invitation.id), input.actorUserId],
    );
    if (accepted.rowCount !== 1) throw new ProjectTeamError("invitation_expired");
    await client.query(
      `insert into user_project_preferences (user_id, selected_project_id)
       values ($1, $2)
       on conflict (user_id) do update
         set selected_project_id = excluded.selected_project_id, updated_at = now()`,
      [input.actorUserId, projectId],
    );
    await client.query(
      `insert into audit_events (
         project_id, actor_user_id, action, entity_type, entity_id,
         safe_data, request_id
       ) values ($1, $2, 'project.invitation.accepted', 'project_invitation', $3::text,
                 jsonb_build_object('role', $4::text), $5)`,
      [
        projectId,
        input.actorUserId,
        Number(invitation.id),
        invitation.role,
        input.requestId?.slice(0, 128) || null,
      ],
    );
    return { projectId, role: invitation.role };
  });
}
