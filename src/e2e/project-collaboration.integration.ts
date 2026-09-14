import { readFile } from "node:fs/promises";
import { NextRequest, NextResponse } from "next/server";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { migrate } from "../../scripts/migrate.mjs";
import {
  acceptProjectInvitation,
  createProject,
  createProjectInvitation,
  hashInvitationToken,
  ProjectTeamError,
} from "@/lib/project-team";
import {
  changeProjectMemberRole,
  ProjectMembershipMutationError,
} from "@/lib/project-context";

const mocks = vi.hoisted(() => ({
  getPool: vi.fn(),
  getSessionUser: vi.fn(),
  checkRateLimit: vi.fn(),
  rateLimitResponse: vi.fn(),
  probePublication: vi.fn(),
  queueAdd: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ getPool: mocks.getPool }));
vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: mocks.checkRateLimit,
  rateLimitResponse: mocks.rateLimitResponse,
}));
vi.mock("@/lib/readiness-probes", () => ({
  probeRedisAndPublicationWorker: mocks.probePublication,
}));
vi.mock("@/lib/queue", () => ({
  getPublishQueue: () => ({ add: mocks.queueAdd }),
  jobIdForPostRevision: (postId: number, revision: number) => `publish-post-${postId}-r${revision}`,
}));

import { POST as publish } from "@/app/api/publication-operations/route";
import { GET as listNotifications } from "@/app/api/project-notifications/route";
import { POST as markNotificationRead } from "@/app/api/project-notifications/[id]/read/route";
import { POST as markAllNotificationsRead } from "@/app/api/project-notifications/read-all/route";

const databaseUrl = String(process.env.MIGRATION_TEST_DATABASE_URL || "").trim();
const target = databaseUrl ? new URL(databaseUrl) : null;
if (!target || !["localhost", "127.0.0.1", "::1"].includes(target.hostname)
  || target.pathname.slice(1) !== "aurora_publication_gate_test") {
  throw new Error("Project collaboration integration requires disposable local aurora_publication_gate_test database");
}

const pool = new pg.Pool({ connectionString: databaseUrl, ssl: false, max: 12 });
let ownerOneId = 0;
let ownerTwoId = 0;
let authorId = 0;
let projectId = 0;
let foreignProjectId = 0;

function getRequest(query = "") {
  return new NextRequest(`http://localhost/api/project-notifications${query}`);
}

function mutationRequest(path: string) {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { origin: "http://localhost" },
  });
}

function rejectedCode(result: PromiseSettledResult<unknown>): string | null {
  if (result.status !== "rejected") return null;
  if (result.reason instanceof ProjectTeamError || result.reason instanceof ProjectMembershipMutationError) {
    return result.reason.code;
  }
  return null;
}

beforeAll(async () => {
  await pool.query("drop schema public cascade");
  await pool.query("create schema public");
  await pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8"));
  await migrate({ env: { ...process.env, DATABASE_URL: databaseUrl }, logger: { log() {} } });

  const users = await pool.query<{ id: string }>(
    `insert into users (email, name)
     values ('owner-one@example.test', 'Owner One'),
            ('owner-two@example.test', 'Owner Two'),
            ('author@example.test', 'Author')
     returning id`,
  );
  [ownerOneId, ownerTwoId, authorId] = users.rows.map((row) => Number(row.id));

  projectId = Number((await pool.query<{ id: string }>(
    `insert into projects (name, timezone, created_by_user_id)
     values ('Collaboration project', 'UTC', $1)
     returning id`,
    [ownerOneId],
  )).rows[0].id);
  foreignProjectId = Number((await pool.query<{ id: string }>(
    `insert into projects (name, timezone, created_by_user_id)
     values ('Foreign project', 'UTC', $1)
     returning id`,
    [ownerOneId],
  )).rows[0].id);

  await pool.query(
    `insert into project_members (project_id, user_id, role)
     values ($1, $2, 'owner'), ($1, $3, 'owner'), ($4, $2, 'owner')`,
    [projectId, ownerOneId, ownerTwoId, foreignProjectId],
  );
  await pool.query(
    `insert into user_project_preferences (user_id, selected_project_id)
     values ($1, $3), ($2, $3)`,
    [ownerOneId, ownerTwoId, projectId],
  );
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getPool.mockReturnValue(pool);
  mocks.getSessionUser.mockResolvedValue({ id: authorId, email: "author@example.test" });
  mocks.checkRateLimit.mockResolvedValue({
    allowed: true,
    limit: 3_600,
    remaining: 3_599,
    retryAfter: 0,
  });
  mocks.rateLimitResponse.mockImplementation(() => NextResponse.json(
    { ok: false, error: "rate_limited" },
    { status: 429 },
  ));
  mocks.probePublication.mockResolvedValue({ redis: "up", publicationWorker: "up" });
});

afterAll(async () => {
  await pool.end();
});

describe.sequential("project collaboration server contracts", () => {
  it("creates a team project and stores its audit identity with stable PostgreSQL types", async () => {
    const created = await createProject({
      pool,
      actorUserId: ownerOneId,
      name: "Typed audit project",
      timezone: "UTC",
      requestId: "project-collaboration-integration",
    });
    const audit = (await pool.query<{ entity_id: string }>(
      `select entity_id from audit_events
        where project_id = $1 and action = 'project.created'
        order by id desc limit 1`,
      [created.id],
    )).rows[0];

    expect(created).toMatchObject({ role: "owner", selected: true });
    expect(audit?.entity_id).toBe(String(created.id));
  });

  it("persists the requested invitation TTL without storing the raw token and rejects expiry", async () => {
    const created = await createProjectInvitation({
      pool,
      actorUserId: ownerOneId,
      projectId,
      email: "author@example.test",
      role: "author",
      ttlDays: 1,
    });
    const stored = (await pool.query<{
      token_hash: string;
      ttl_seconds: string;
    }>(
      `select token_hash, extract(epoch from (expires_at - created_at))::text as ttl_seconds
         from project_invitations
        where id = $1`,
      [created.invitation.id],
    )).rows[0];

    expect(stored.token_hash).toBe(hashInvitationToken(created.token));
    expect(stored.token_hash).not.toContain(created.token);
    expect(Number(stored.ttl_seconds)).toBeGreaterThan(86_300);
    expect(Number(stored.ttl_seconds)).toBeLessThanOrEqual(86_400);

    await pool.query(
      `update project_invitations
          set created_at = now() - interval '2 days',
              expires_at = now() - interval '1 day'
        where id = $1`,
      [created.invitation.id],
    );
    await expect(acceptProjectInvitation({
      pool,
      actorUserId: authorId,
      token: created.token,
    })).rejects.toMatchObject({ code: "invitation_expired" });
    const membership = await pool.query(
      `select 1 from project_members
        where project_id = $1 and user_id = $2 and status = 'active'`,
      [projectId, authorId],
    );
    expect(membership.rowCount).toBe(0);
  });

  it("linearizes concurrent invitation acceptance and makes the token single-use", async () => {
    const created = await createProjectInvitation({
      pool,
      actorUserId: ownerOneId,
      projectId,
      email: "author@example.test",
      role: "author",
      ttlDays: 7,
    });
    const accepted = await Promise.allSettled([
      acceptProjectInvitation({ pool, actorUserId: authorId, token: created.token }),
      acceptProjectInvitation({ pool, actorUserId: authorId, token: created.token }),
    ]);

    expect(accepted.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(accepted.map(rejectedCode).filter(Boolean)).toEqual(["invitation_used"]);
    await expect(acceptProjectInvitation({
      pool,
      actorUserId: authorId,
      token: created.token,
    })).rejects.toMatchObject({ code: "invitation_used" });

    const state = (await pool.query<{
      role: string;
      status: string;
      accepted_by_user_id: string;
      accepted_at: Date;
    }>(
      `select member.role, member.status,
              invitation.accepted_by_user_id, invitation.accepted_at
         from project_members member
         join project_invitations invitation on invitation.id = $3
        where member.project_id = $1 and member.user_id = $2`,
      [projectId, authorId, created.invitation.id],
    )).rows[0];
    expect(state).toMatchObject({ role: "author", status: "active" });
    expect(Number(state.accepted_by_user_id)).toBe(authorId);
    expect(state.accepted_at).toBeInstanceOf(Date);
  });

  it("forbids an author from publishing before readiness or queue side effects", async () => {
    const response = await publish(new NextRequest("http://localhost/api/publication-operations", {
      method: "POST",
      headers: {
        origin: "http://localhost",
        "content-type": "application/json",
        "idempotency-key": "author-publish-contract",
      },
      body: JSON.stringify({ draftId: 1, draftVersion: 1, timezone: "UTC" }),
    }));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: "forbidden" });
    expect(mocks.probePublication).not.toHaveBeenCalled();
    expect(mocks.queueAdd).not.toHaveBeenCalled();
    const operations = await pool.query(
      `select 1 from publication_operations where project_id = $1 and user_id = $2`,
      [projectId, authorId],
    );
    expect(operations.rowCount).toBe(0);
  });

  it("runs the full list, mark-one, mark-all notification cycle with tenant isolation", async () => {
    const ownNotifications = await pool.query<{ id: string }>(
      `insert into project_notifications
         (project_id, recipient_user_id, actor_user_id, event_type, entity_type, entity_id)
       values ($1, $2, $3, 'draft_comment_added', 'draft', '101'),
              ($1, $2, $3, 'draft_approved', 'draft', '102'),
              ($1, $2, $3, 'draft_ready_to_publish', 'draft', '103')
       returning id`,
      [projectId, authorId, ownerOneId],
    );
    const notificationIds = ownNotifications.rows.map((row) => Number(row.id));
    const foreignNotificationId = Number((await pool.query<{ id: string }>(
      `insert into project_notifications
         (project_id, recipient_user_id, actor_user_id, event_type, entity_type, entity_id)
       values ($1, $2, $3, 'foreign_event', 'draft', '201')
       returning id`,
      [foreignProjectId, authorId, ownerOneId],
    )).rows[0].id);
    const otherRecipientNotificationId = Number((await pool.query<{ id: string }>(
      `insert into project_notifications
         (project_id, recipient_user_id, actor_user_id, event_type, entity_type, entity_id)
       values ($1, $2, $3, 'owner_event', 'draft', '301')
       returning id`,
      [projectId, ownerOneId, ownerTwoId],
    )).rows[0].id);

    const initialResponse = await listNotifications(getRequest("?limit=20&unread=true"));
    expect(initialResponse.status).toBe(200);
    const initial = await initialResponse.json();
    expect(initial.inbox.projectId).toBe(projectId);
    expect(initial.inbox.unreadCount).toBe(3);
    expect(initial.inbox.notifications.map((item: { id: number }) => item.id).sort((a: number, b: number) => a - b))
      .toEqual([...notificationIds].sort((a, b) => a - b));

    const markedId = notificationIds[1];
    const markOneResponse = await markNotificationRead(
      mutationRequest(`/api/project-notifications/${markedId}/read`),
      { params: Promise.resolve({ id: String(markedId) }) },
    );
    expect(markOneResponse.status).toBe(200);
    await expect(markOneResponse.json()).resolves.toMatchObject({
      ok: true,
      projectId,
      notificationId: markedId,
      unreadCount: 2,
    });

    const remainingResponse = await listNotifications(getRequest("?limit=20&unread=true"));
    const remaining = await remainingResponse.json();
    expect(remaining.inbox.unreadCount).toBe(2);
    expect(remaining.inbox.notifications.map((item: { id: number }) => item.id)).not.toContain(markedId);

    const markAllResponse = await markAllNotificationsRead(
      mutationRequest("/api/project-notifications/read-all"),
    );
    expect(markAllResponse.status).toBe(200);
    await expect(markAllResponse.json()).resolves.toMatchObject({
      ok: true,
      projectId,
      markedCount: 2,
      unreadCount: 0,
    });

    const finalResponse = await listNotifications(getRequest("?limit=20"));
    const finalState = await finalResponse.json();
    expect(finalState.inbox.unreadCount).toBe(0);
    expect(finalState.inbox.notifications).toHaveLength(3);
    expect(finalState.inbox.notifications.every((item: { readAt: string | null }) => item.readAt !== null)).toBe(true);

    const isolatedRows = await pool.query<{ id: string; read_at: Date | null }>(
      `select id, read_at from project_notifications where id = any($1::bigint[]) order by id`,
      [[foreignNotificationId, otherRecipientNotificationId]],
    );
    expect(isolatedRows.rows).toHaveLength(2);
    expect(isolatedRows.rows.every((row) => row.read_at === null)).toBe(true);
  });

  it("serializes concurrent owner demotions and preserves exactly one active owner", async () => {
    const changed = await Promise.allSettled([
      changeProjectMemberRole({
        pool,
        actorUserId: ownerOneId,
        projectId,
        memberUserId: ownerOneId,
        role: "approver",
        expectedVersion: 1,
      }),
      changeProjectMemberRole({
        pool,
        actorUserId: ownerTwoId,
        projectId,
        memberUserId: ownerTwoId,
        role: "publisher",
        expectedVersion: 1,
      }),
    ]);

    expect(changed.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(changed.map(rejectedCode).filter(Boolean)).toEqual(["last_owner"]);
    const owners = await pool.query<{ user_id: string }>(
      `select user_id from project_members
        where project_id = $1 and role = 'owner' and status = 'active'`,
      [projectId],
    );
    expect(owners.rows).toHaveLength(1);
    expect([ownerOneId, ownerTwoId]).toContain(Number(owners.rows[0].user_id));
  });
});
