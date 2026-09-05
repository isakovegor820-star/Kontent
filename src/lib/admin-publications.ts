import type { Pool } from "pg";

type Queryable = Pick<Pool, "query">;
type Transactional = Pick<Pool, "query" | "connect">;
type PublishQueue = {
  add: (name: string, data: Record<string, unknown>, options?: Record<string, unknown>) => Promise<unknown>;
};

export const ADMIN_PUBLICATION_STATUS_FILTERS = [
  "attention",
  "all",
  "failed",
  "quarantined",
  "overdue",
  "failed_retry",
  "scheduled",
  "publishing",
  "published_unverified",
  "published",
  "cancelled",
] as const;
export type AdminPublicationStatusFilter = (typeof ADMIN_PUBLICATION_STATUS_FILTERS)[number];

export const ADMIN_PUBLICATION_SORTS = ["recent", "scheduled_asc", "attempts_desc"] as const;
export type AdminPublicationSort = (typeof ADMIN_PUBLICATION_SORTS)[number];

export type AdminPublicationAttention = "failed" | "quarantined" | "overdue" | "auth" | null;

export interface AdminPublicationsQuery {
  query: string;
  status: AdminPublicationStatusFilter;
  network: string;
  projectId: number | null;
  errorCode: string;
  sort: AdminPublicationSort;
  page: number;
  pageSize: number;
}

export interface AdminPublicationItem {
  id: number;
  projectId: number;
  project: string;
  authorId: number;
  author: string;
  channelId: number;
  channel: string;
  network: string;
  channelStatus: string;
  status: string;
  attention: AdminPublicationAttention;
  attempts: number;
  errorCode: string | null;
  text: string;
  origin: string;
  hasMedia: boolean;
  operationId: number | null;
  scheduledAt: string | null;
  publishedAt: string | null;
  createdAt: string;
  /** A provider call is in flight; every admin mutation is fenced off. */
  inFlight: boolean;
  canRetry: boolean;
  canCancel: boolean;
  canReschedule: boolean;
}

export interface AdminPublicationsResponse {
  checkedAt: string;
  summary: {
    attention: number;
    failed: number;
    quarantined: number;
    overdue: number;
    failedRetry: number;
    scheduled: number;
    publishing: number;
    publishedUnverified: number;
    publishedToday: number;
    total: number;
  };
  items: AdminPublicationItem[];
  pagination: { page: number; pageSize: number; total: number; pages: number };
  options: { networks: string[]; errorCodes: string[]; projects: Array<{ id: number; label: string }> };
}

export const OVERDUE_INTERVAL_SQL = "interval '5 minutes'";

const RETRYABLE_STATUSES = ["failed", "quarantined", "failed_retry"] as const;
const CANCELLABLE_STATUSES = ["scheduled", "failed_retry", "failed", "quarantined"] as const;
const RESCHEDULABLE_STATUSES = ["scheduled", "failed", "quarantined", "failed_retry"] as const;
const MAX_RESCHEDULE_AHEAD_MS = 366 * 24 * 60 * 60_000;
const SAFE_ERROR_CODE = /^[a-z0-9][a-z0-9_.:-]{0,99}$/u;
const SAFE_NETWORK = /^[a-z0-9_-]{1,32}$/u;

function count(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : 0;
}

function positiveId(value: unknown): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

function iso(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value || ""));
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date(0).toISOString();
}

function nullableIso(value: unknown): string | null {
  return value == null ? null : iso(value);
}

export function normalizeAdminPublicationsQuery(params: URLSearchParams): AdminPublicationsQuery {
  const statusValue = params.get("status") ?? "attention";
  const sortValue = params.get("sort") ?? "recent";
  const networkValue = String(params.get("network") ?? "all").trim().toLowerCase();
  const errorValue = String(params.get("error") ?? "").trim().toLowerCase();
  const page = Number(params.get("page") ?? "1");
  const projectId = positiveId(params.get("project"));
  return {
    query: String(params.get("q") ?? "").trim().slice(0, 200),
    status: ADMIN_PUBLICATION_STATUS_FILTERS.includes(statusValue as AdminPublicationStatusFilter)
      ? statusValue as AdminPublicationStatusFilter : "attention",
    network: networkValue !== "all" && SAFE_NETWORK.test(networkValue) ? networkValue : "all",
    projectId: projectId || null,
    errorCode: SAFE_ERROR_CODE.test(errorValue) ? errorValue : "",
    sort: ADMIN_PUBLICATION_SORTS.includes(sortValue as AdminPublicationSort) ? sortValue as AdminPublicationSort : "recent",
    page: Number.isSafeInteger(page) && page > 0 ? Math.min(page, 10_000) : 1,
    pageSize: 25,
  };
}

const ORDER_BY: Record<AdminPublicationSort, string> = {
  recent: "coalesce(base.scheduled_at, base.created_at) desc, base.id desc",
  scheduled_asc: "base.scheduled_at asc nulls last, base.id asc",
  attempts_desc: "base.attempts desc, coalesce(base.scheduled_at, base.created_at) desc, base.id desc",
};

/**
 * Shared classification of a post row into the admin attention model. Auth problems on
 * the channel come first because they block every future publication of that channel.
 */
const ATTENTION_SQL = `
  case
    when channel.is_active = true and channel.status <> 'active'
         and post.status in ('scheduled','failed','failed_retry','quarantined','publishing') then 'auth'
    when post.status = 'quarantined' or post.quarantined_at is not null and post.status <> 'published' then 'quarantined'
    when post.status = 'scheduled' and post.scheduled_at < now() - ${OVERDUE_INTERVAL_SQL} then 'overdue'
    when post.status = 'failed' then 'failed'
    else null
  end`;

const ERROR_CODE_SQL = `
  case
    when channel.is_active = true and channel.status <> 'active'
         and post.status in ('scheduled','failed','failed_retry','quarantined','publishing')
      then coalesce(channel.last_auth_error_code, 'integration_reconnect_required')
    when post.status = 'quarantined' or post.quarantined_at is not null and post.status <> 'published'
      then coalesce(post.quarantine_reason, 'publication_quarantined')
    when post.status = 'scheduled' and post.scheduled_at < now() - ${OVERDUE_INTERVAL_SQL}
      then 'publication_overdue'
    when post.status in ('failed','failed_retry','missing','deleted_external','published_unverified')
      then coalesce(post.verification_error_code, 'provider_error')
    else null
  end`;

export async function loadAdminPublications(
  db: Queryable,
  input: AdminPublicationsQuery,
): Promise<AdminPublicationsResponse> {
  const offset = (input.page - 1) * input.pageSize;
  const search = `%${input.query.replace(/[%_\\]/gu, (char) => `\\${char}`)}%`;
  const [summary, rows, options] = await Promise.all([
    db.query<Record<string, unknown>>(
      `select
         count(*) filter (where (${ATTENTION_SQL}) is not null) as attention,
         count(*) filter (where post.status = 'failed') as failed,
         count(*) filter (where post.status = 'quarantined' or (post.quarantined_at is not null and post.status <> 'published')) as quarantined,
         count(*) filter (where post.status = 'scheduled' and post.scheduled_at < now() - ${OVERDUE_INTERVAL_SQL}) as overdue,
         count(*) filter (where post.status = 'failed_retry') as failed_retry,
         count(*) filter (where post.status = 'scheduled') as scheduled,
         count(*) filter (where post.status = 'publishing') as publishing,
         count(*) filter (where post.status = 'published_unverified') as published_unverified,
         count(*) filter (where post.published_at >= date_trunc('day', now())) as published_today,
         count(*) filter (where channel.is_active = true and channel.status <> 'active'
           and post.status in ('scheduled','failed','failed_retry','quarantined','publishing')) as auth,
         count(*) as total
       from posts post
       join channels channel on channel.id = post.channel_id`,
    ),
    db.query<Record<string, unknown>>(
      `with base as (
         select post.id, post.project_id, post.user_id, post.channel_id, post.status, post.attempts,
                post.publication_origin as origin, post.media is not null as has_media,
                post.publication_operation_id as operation_id,
                post.scheduled_at, post.published_at, post.created_at,
                post.publish_lease_token is not null as in_flight,
                post.text as text,
                post.text ilike $2 as text_match, author.email ilike $2 as email_match,
                channel.network, channel.status as channel_status,
                coalesce(nullif(btrim(channel.title), ''), nullif(btrim(channel.handle), ''), 'Канал ' || channel.id::text) as channel,
                project.name as project,
                coalesce(nullif(btrim(author.name), ''), author.email, 'Пользователь ' || author.id::text) as author,
                ${ATTENTION_SQL} as attention,
                ${ERROR_CODE_SQL} as error_code
           from posts post
           join channels channel on channel.id = post.channel_id
           join projects project on project.id = post.project_id
           join users author on author.id = post.user_id
       ), filtered as (
         select base.* from base
          where ($1::text = ''
                 or base.id::text = $1
                 or base.text_match
                 or base.email_match
                 or base.project ilike $2
                 or base.channel ilike $2
                 or base.author ilike $2)
            and ($3::text = 'all'
                 or ($3 = 'attention' and base.attention is not null)
                 or ($3 = 'overdue' and base.attention = 'overdue')
                 or ($3 = 'quarantined' and base.attention = 'quarantined')
                 or ($3 not in ('attention','overdue','quarantined') and base.status = $3))
            and ($4::text = 'all' or base.network = $4)
            and ($5::bigint is null or base.project_id = $5)
            and ($6::text = '' or base.error_code = $6)
       )
       select base.*, count(*) over() as filtered_total
         from filtered base
        order by ${ORDER_BY[input.sort]}
        limit $7 offset $8`,
      [input.query, search, input.status, input.network, input.projectId, input.errorCode, input.pageSize, offset],
    ),
    db.query<{ networks: string[] | null; error_codes: string[] | null; projects: Array<{ id: number | string; label: string }> | null }>(
      `select
         (select array_agg(distinct channel.network order by channel.network) from channels channel) as networks,
         (select array_agg(distinct code order by code) from (
            select ${ERROR_CODE_SQL} as code
              from posts post join channels channel on channel.id = post.channel_id
             where post.created_at >= now() - interval '90 days'
          ) codes where code is not null) as error_codes,
         (select json_agg(json_build_object('id', project.id, 'label', project.name) order by project.name)
            from projects project where project.is_archived = false) as projects`,
    ),
  ]);

  const totals = summary.rows[0] ?? {};
  const total = count(rows.rows[0]?.filtered_total);
  const optionRow = options.rows[0];
  return {
    checkedAt: new Date().toISOString(),
    summary: {
      attention: count(totals.attention),
      failed: count(totals.failed),
      quarantined: count(totals.quarantined),
      overdue: count(totals.overdue),
      failedRetry: count(totals.failed_retry),
      scheduled: count(totals.scheduled),
      publishing: count(totals.publishing),
      publishedUnverified: count(totals.published_unverified),
      publishedToday: count(totals.published_today),
      total: count(totals.total),
    },
    items: rows.rows.map((row) => {
      const status = String(row.status);
      const inFlight = row.in_flight === true || status === "publishing";
      const attention = (row.attention as AdminPublicationAttention) ?? null;
      // A retry into a channel that lost authorisation fails again immediately; the owner
      // has to reconnect first, so the action is hidden instead of producing a false hope.
      const channelBlocked = attention === "auth";
      return {
        id: positiveId(row.id),
        projectId: positiveId(row.project_id),
        project: String(row.project || "Проект"),
        authorId: positiveId(row.user_id),
        author: String(row.author || "Пользователь"),
        channelId: positiveId(row.channel_id),
        channel: String(row.channel || "Канал"),
        network: String(row.network),
        channelStatus: String(row.channel_status || "active"),
        status,
        attention,
        attempts: count(row.attempts),
        errorCode: row.error_code == null ? null : String(row.error_code),
        text: String(row.text || "Публикация без текста"),
        origin: String(row.origin || "manual"),
        hasMedia: row.has_media === true,
        operationId: row.operation_id == null ? null : positiveId(row.operation_id),
        scheduledAt: nullableIso(row.scheduled_at),
        publishedAt: nullableIso(row.published_at),
        createdAt: iso(row.created_at),
        inFlight,
        canRetry: !inFlight && !channelBlocked && (RETRYABLE_STATUSES as readonly string[]).includes(status),
        canCancel: !inFlight && (CANCELLABLE_STATUSES as readonly string[]).includes(status),
        canReschedule: !inFlight && !channelBlocked && (RESCHEDULABLE_STATUSES as readonly string[]).includes(status),
      };
    }),
    pagination: {
      page: input.page,
      pageSize: input.pageSize,
      total,
      pages: Math.max(1, Math.ceil(total / input.pageSize)),
    },
    options: {
      networks: optionRow?.networks ?? [],
      errorCodes: optionRow?.error_codes ?? [],
      projects: (optionRow?.projects ?? []).map((project) => ({ id: positiveId(project.id), label: String(project.label) })),
    },
  };
}

export type AdminPublicationActionResult =
  | { status: "queued"; postId: number; scheduleRevision: number; scheduledAt: string }
  | { status: "cancelled"; postId: number }
  | { status: "not_found" }
  | { status: "in_progress" }
  | { status: "not_allowed"; currentStatus: string }
  | { status: "invalid_time" }
  | { status: "queue_unavailable" };

type PostStateRow = { status: string; in_flight: boolean };

function failureFor(state: PostStateRow | null): AdminPublicationActionResult {
  if (!state) return { status: "not_found" };
  if (state.in_flight || state.status === "publishing") return { status: "in_progress" };
  return { status: "not_allowed", currentStatus: state.status };
}

async function writeAudit(
  db: Queryable,
  input: {
    projectId: number;
    actorUserId: number;
    action: string;
    postId: number;
    fromStatus: string;
    toStatus: string;
    requestId: string | null;
    safeData?: Record<string, string | number | null>;
  },
) {
  await db.query(
    `insert into audit_events (project_id, actor_user_id, action, entity_type, entity_id, safe_data, request_id)
     values ($1, $2, $3, 'post', $4::text, $5::jsonb, $6)`,
    [
      input.projectId,
      input.actorUserId,
      input.action,
      String(input.postId),
      JSON.stringify({ from: input.fromStatus, to: input.toStatus, by: "admin", ...(input.safeData ?? {}) }),
      input.requestId,
    ],
  );
}

/**
 * Puts a confirmed failure, a quarantined or a retry-pending post back into the queue right
 * now. The schedule revision is bumped so any stale delayed job is ignored by the worker's
 * lease claim; a delivery in flight is never touched.
 */
export async function retryAdminPublication(
  pool: Transactional,
  queue: PublishQueue,
  input: { actorUserId: number; postId: number; requestId?: string | null },
): Promise<AdminPublicationActionResult> {
  return moveAdminPublication(pool, queue, {
    ...input,
    scheduledAt: new Date(),
    allowedStatuses: RETRYABLE_STATUSES,
    action: "publication.admin.retried",
  });
}

export async function rescheduleAdminPublication(
  pool: Transactional,
  queue: PublishQueue,
  input: { actorUserId: number; postId: number; scheduledAt: string; requestId?: string | null },
): Promise<AdminPublicationActionResult> {
  const scheduledAt = new Date(input.scheduledAt);
  const delta = scheduledAt.getTime() - Date.now();
  if (!Number.isFinite(scheduledAt.getTime()) || delta < -60_000 || delta > MAX_RESCHEDULE_AHEAD_MS) {
    return { status: "invalid_time" };
  }
  return moveAdminPublication(pool, queue, {
    actorUserId: input.actorUserId,
    postId: input.postId,
    requestId: input.requestId,
    scheduledAt: delta < 0 ? new Date() : scheduledAt,
    allowedStatuses: RESCHEDULABLE_STATUSES,
    action: "publication.admin.rescheduled",
  });
}

async function moveAdminPublication(
  pool: Transactional,
  queue: PublishQueue,
  input: {
    actorUserId: number;
    postId: number;
    requestId?: string | null;
    scheduledAt: Date;
    allowedStatuses: readonly string[];
    action: string;
  },
): Promise<AdminPublicationActionResult> {
  const client = await pool.connect();
  let moved: { id: number; project_id: number; schedule_revision: number; from_status: string } | null = null;
  try {
    await client.query("begin");
    const before = await client.query<{ status: string; in_flight: boolean }>(
      `select status, publish_lease_token is not null as in_flight from posts where id = $1 for update`,
      [input.postId],
    );
    const state = before.rows[0] ?? null;
    if (!state || state.in_flight || state.status === "publishing" || !input.allowedStatuses.includes(state.status)) {
      await client.query("rollback");
      return failureFor(state);
    }
    const updated = await client.query<{ id: number | string; project_id: number | string; schedule_revision: number | string }>(
      `update posts
          set status = 'scheduled', scheduled_at = $2, schedule_revision = schedule_revision + 1,
              last_error = null, next_attempt_at = null, publish_lease_token = null,
              quarantined_at = null, quarantine_reason = null, cancelled_at = null,
              retry_requested_at = now()
        where id = $1 and publish_lease_token is null
        returning id, project_id, schedule_revision`,
      [input.postId, input.scheduledAt],
    );
    const row = updated.rows[0];
    if (!row) {
      await client.query("rollback");
      return { status: "in_progress" };
    }
    moved = {
      id: positiveId(row.id),
      project_id: positiveId(row.project_id),
      schedule_revision: count(row.schedule_revision),
      from_status: state.status,
    };
    await writeAudit(client, {
      projectId: moved.project_id,
      actorUserId: input.actorUserId,
      action: input.action,
      postId: moved.id,
      fromStatus: state.status,
      toStatus: "scheduled",
      requestId: input.requestId ?? null,
      safeData: { scheduled_at: input.scheduledAt.toISOString(), revision: moved.schedule_revision },
    });
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  try {
    await queue.add(
      "publish",
      { postId: moved.id, projectId: moved.project_id, scheduleRevision: moved.schedule_revision },
      {
        delay: Math.max(0, input.scheduledAt.getTime() - Date.now()),
        jobId: `post-${moved.id}-r${moved.schedule_revision}`,
        removeOnComplete: true,
        removeOnFail: false,
      },
    );
  } catch {
    // PostgreSQL and Redis do not share a transaction: never leave a scheduled row without a job.
    await pool.query(
      `update posts
          set status = $3, last_error = 'Очередь публикаций недоступна — повторите позже', next_attempt_at = null
        where id = $1 and schedule_revision = $2 and status = 'scheduled'`,
      [moved.id, moved.schedule_revision, moved.from_status === "failed_retry" ? "failed" : moved.from_status],
    ).catch(() => undefined);
    return { status: "queue_unavailable" };
  }
  return { status: "queued", postId: moved.id, scheduleRevision: moved.schedule_revision, scheduledAt: input.scheduledAt.toISOString() };
}

/** Cancels a pending publication; the revision bump makes any queued job stale. */
export async function cancelAdminPublication(
  pool: Transactional,
  input: { actorUserId: number; postId: number; reason?: string | null; requestId?: string | null },
): Promise<AdminPublicationActionResult> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const before = await client.query<{ status: string; in_flight: boolean; project_id: number | string }>(
      `select status, publish_lease_token is not null as in_flight, project_id from posts where id = $1 for update`,
      [input.postId],
    );
    const state = before.rows[0] ?? null;
    if (!state || state.in_flight || state.status === "publishing" || !(CANCELLABLE_STATUSES as readonly string[]).includes(state.status)) {
      await client.query("rollback");
      return failureFor(state);
    }
    await client.query(
      `update posts
          set status = 'cancelled', cancelled_at = now(), schedule_revision = schedule_revision + 1,
              next_attempt_at = null, publish_lease_token = null
        where id = $1 and publish_lease_token is null`,
      [input.postId],
    );
    await writeAudit(client, {
      projectId: positiveId(state.project_id),
      actorUserId: input.actorUserId,
      action: "publication.admin.cancelled",
      postId: input.postId,
      fromStatus: state.status,
      toStatus: "cancelled",
      requestId: input.requestId ?? null,
      safeData: { reason: input.reason ? input.reason.slice(0, 200) : null },
    });
    await client.query("commit");
    return { status: "cancelled", postId: input.postId };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
