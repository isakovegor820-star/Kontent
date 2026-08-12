import { randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";

import {
  createProjectExportSnapshot,
  projectExportHash,
  type ProjectExportFormat,
  type ProjectExportKind,
  type ProjectExportSnapshot,
} from "@/lib/project-export.mjs";
import { requireSelectedProjectPermission } from "@/lib/project-permissions";

type Queryable = Pick<PoolClient, "query">;
type TransactionPool = Pick<Pool, "query" | "connect">;

const MAX_SOURCE_ROWS = 25_000;
const SYNC_ROW_LIMIT = 500;
const SYNC_SNAPSHOT_BYTES = 512 * 1024;
const DOWNLOAD_TOKEN_TTL_MS = 15 * 60 * 1_000;
const MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;
const FILTER_KEYS = ["channel", "author", "campaign", "status"] as const;
const REQUEST_KEYS = ["kind", "format", "period", "filters", "previewHash"] as const;
const PERIOD_KEYS = ["from", "to"] as const;

type FilterKey = (typeof FILTER_KEYS)[number];
type NormalizedFilters = Record<FilterKey, string[]>;
type NormalizedRequest = {
  kind: ProjectExportKind;
  format: ProjectExportFormat;
  period: { from: string; to: string };
  filters: NormalizedFilters;
  requestKey: string;
  previewHash: string;
};

type NormalizedSelection = Omit<NormalizedRequest, "requestKey" | "previewHash">;

export type ProjectExportPreview = {
  kind: ProjectExportKind;
  timezone: string;
  period: { from: string; to: string };
  filters: NormalizedFilters;
  rowCount: number;
  exceedsLimit: boolean;
  previewHash: string;
  sample: Array<{
    id: string;
    occurredAt: string;
    channel: string;
    title: string;
    status: string;
    author: string;
    campaign: string;
  }>;
};

const CONTENT_STATUS: Readonly<Record<string, string>> = {
  draft: "Черновик",
  scheduled: "Запланирован",
  publishing: "Публикуется",
  published_unverified: "Опубликован, проверяется",
  published: "Опубликован",
  missing: "Не найден во внешнем канале",
  deleted_external: "Удалён во внешнем канале",
  failed_retry: "Ожидает повтора",
  quarantined: "Требует проверки",
  cancelled: "Отменён",
  failed: "Ошибка",
  in_review: "На согласовании",
  approved: "Согласован",
  confirmed: "Подтверждено",
};

export type ProjectExportRequest = {
  kind?: unknown;
  format?: unknown;
  period?: { from?: unknown; to?: unknown } | null;
  filters?: Partial<Record<FilterKey, unknown>> | null;
  previewHash?: unknown;
};

export type ProjectExportOperationView = {
  id: number;
  kind: ProjectExportKind;
  format: ProjectExportFormat;
  status: string;
  filters: Record<string, unknown>;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  artifact: null | {
    byteSize: number;
    fileName: string;
    mimeType: string;
    expiresAt: string;
  };
};

export class ProjectExportServiceError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status = 422) {
    super(code);
    this.name = "ProjectExportServiceError";
    this.code = code;
    this.status = status;
  }
}

function positiveId(value: unknown): number | null {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function iso(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  return date.toISOString();
}

function normalizeDateOnly(value: unknown): string {
  const text = String(value ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(text)) throw new ProjectExportServiceError("invalid_period");
  const date = new Date(`${text}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== text) {
    throw new ProjectExportServiceError("invalid_period");
  }
  return text;
}

function normalizePeriod(value: ProjectExportRequest["period"]) {
  const from = normalizeDateOnly(value?.from);
  const to = normalizeDateOnly(value?.to);
  const days = (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000 + 1;
  if (days < 1 || days > 366) throw new ProjectExportServiceError("invalid_period");
  return { from, to };
}

function normalizeRequestKey(value: unknown): string {
  const key = String(value ?? "").trim();
  if (!/^[A-Za-z0-9._:-]{8,128}$/u.test(key)) {
    throw new ProjectExportServiceError("idempotency_key_required", 400);
  }
  return key;
}

function normalizeFilterValue(value: unknown, key: FilterKey): string[] {
  const input = value == null || value === "" ? [] : Array.isArray(value) ? value : [value];
  if (input.length > 20) throw new ProjectExportServiceError("invalid_filters");
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of input) {
    let text = String(item ?? "").normalize("NFKC").trim();
    if (key === "status") text = CONTENT_STATUS[text] ?? text;
    if (!text || text.length > 120 || /[\p{Cc}\p{Cf}]/u.test(text)) {
      throw new ProjectExportServiceError("invalid_filters");
    }
    const comparison = text.toLocaleLowerCase("ru-RU");
    if (!seen.has(comparison)) {
      seen.add(comparison);
      result.push(text);
    }
  }
  return result;
}

function normalizeSelection(body: ProjectExportRequest): NormalizedSelection {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ProjectExportServiceError("invalid_export_request", 400);
  }
  if (Object.keys(body).some((key) => !REQUEST_KEYS.includes(key as (typeof REQUEST_KEYS)[number]))) {
    throw new ProjectExportServiceError("invalid_export_request", 400);
  }
  if (!body.period || typeof body.period !== "object" || Array.isArray(body.period)
    || Object.keys(body.period).some((key) => !PERIOD_KEYS.includes(key as (typeof PERIOD_KEYS)[number]))) {
    throw new ProjectExportServiceError("invalid_period");
  }
  if (body.kind !== "content_plan" && body.kind !== "analytics") {
    throw new ProjectExportServiceError("invalid_export_kind");
  }
  if (body.format !== "csv" && body.format !== "xlsx" && body.format !== "pdf") {
    throw new ProjectExportServiceError("invalid_export_format");
  }
  const unknownFilters = body.filters ?? {};
  if (!unknownFilters || typeof unknownFilters !== "object" || Array.isArray(unknownFilters)) {
    throw new ProjectExportServiceError("invalid_filters");
  }
  if (Object.keys(unknownFilters).some((key) => !FILTER_KEYS.includes(key as FilterKey))) {
    throw new ProjectExportServiceError("invalid_filters");
  }
  const filters = Object.fromEntries(
    FILTER_KEYS.map((key) => [key, normalizeFilterValue(unknownFilters[key], key)]),
  ) as NormalizedFilters;
  return {
    kind: body.kind as ProjectExportKind,
    format: body.format as ProjectExportFormat,
    period: normalizePeriod(body.period),
    filters,
  };
}

function normalizePreviewHash(value: unknown): string {
  const hash = String(value ?? "");
  if (!/^[0-9a-f]{64}$/u.test(hash)) {
    throw new ProjectExportServiceError("preview_required", 409);
  }
  return hash;
}

function normalizeRequest(body: ProjectExportRequest, requestKey: unknown): NormalizedRequest {
  return {
    ...normalizeSelection(body),
    requestKey: normalizeRequestKey(requestKey),
    previewHash: normalizePreviewHash(body.previewHash),
  };
}

function titleFromText(value: unknown): string {
  const first = String(value ?? "").split(/\r?\n/u).map((part) => part.trim()).find(Boolean);
  return [...(first || "Публикация")].slice(0, 240).join("");
}

function channelName(row: Record<string, unknown>): string {
  const title = String(row.channel_title ?? "").trim();
  if (title) return title;
  const handle = String(row.handle ?? "").replace(/^@/u, "").trim();
  if (handle) return `@${handle}`;
  if (row.network === "vk") return "VK";
  if (row.network === "tg") return "Telegram";
  return "Без канала";
}

function postUrl(row: Record<string, unknown>): string {
  const externalId = String(row.external_message_id ?? row.tg_message_id ?? row.vk_post_id ?? "").trim();
  if (!externalId) return "";
  if (row.network === "tg") {
    const handle = String(row.handle ?? "").replace(/^@/u, "").trim();
    return handle ? `https://t.me/${handle}/${encodeURIComponent(externalId)}` : "";
  }
  if (row.network === "vk") {
    const groupId = String(row.vk_group_id ?? "").trim();
    return groupId && /^\d+$/u.test(externalId) ? `https://vk.com/wall-${groupId}_${externalId}` : "";
  }
  return "";
}

function trackedUrl(row: Record<string, unknown>): string {
  const destination = String(row.destination_url ?? "").trim();
  const values = row.utm_values;
  if (!destination || !values || typeof values !== "object" || Array.isArray(values)) return destination;
  try {
    const url = new URL(destination);
    for (const [key, value] of Object.entries(values)) {
      const text = String(value ?? "").trim();
      if (text) url.searchParams.set(key, text);
    }
    return url.toString();
  } catch {
    return destination;
  }
}

function optionalNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function commonRow(row: Record<string, unknown>, projectId: number) {
  return {
    id: String(row.id),
    projectId: String(projectId),
    channel: channelName(row),
    rubric: String(row.rubric ?? ""),
    title: String(row.campaign_title ?? "").trim() || titleFromText(row.text),
    status: CONTENT_STATUS[String(row.status)] ?? String(row.status ?? ""),
    author: String(row.author_name ?? "").trim() || "Не указан",
    approver: String(row.approver_name ?? "").trim() || "Не указан",
    campaign: String(row.campaign_name ?? "").trim(),
    postUrl: postUrl(row),
    shortUrl: String(row.short_url_path ?? ""),
  };
}

const COMMON_POST_JOINS = `
  join channels channel on channel.id = post.channel_id and channel.project_id = post.project_id
  left join users author on author.id = post.user_id
  left join publication_operations operation
    on operation.id = post.publication_operation_id and operation.project_id = post.project_id
  left join lateral (
    select reviewer.name as approver_name
      from draft_editorial_decisions decision
      join users reviewer on reviewer.id = decision.actor_user_id
     where decision.project_id = post.project_id and decision.draft_id = operation.draft_id
       and decision.decision = 'approve'
     order by decision.created_at desc, decision.id desc limit 1
  ) editorial_approval on true
  left join lateral (
    select item.title, item.rubric, campaign.goal as campaign_name,
           coalesce(plan_approver.name, decision_approver.name) as approver_name
      from monthly_campaign_items item
      join monthly_campaign_plans plan on plan.id = item.plan_id and plan.project_id = item.project_id
      join monthly_campaigns campaign on campaign.id = plan.campaign_id and campaign.project_id = item.project_id
      left join users plan_approver on plan_approver.id = plan.approved_by_user_id
      left join lateral (
        select reviewer.name
          from draft_editorial_decisions decision
          join users reviewer on reviewer.id = decision.actor_user_id
         where decision.project_id = item.project_id and decision.draft_id = item.draft_id
           and decision.decision = 'approve'
         order by decision.created_at desc, decision.id desc limit 1
      ) decision_approver on true
     where item.project_id = post.project_id and item.post_id = post.id
     order by item.updated_at desc, item.id desc limit 1
  ) campaign_item on true
  left join lateral (
    select tracking.destination_url, tracking.short_url_path, tracking.utm_values, tracking.short_link_id
      from publication_tracking_snapshots tracking
     where tracking.project_id = post.project_id and tracking.post_id = post.id
     order by (tracking.placement = 'post') desc, tracking.created_at desc, tracking.id desc limit 1
  ) tracking on true`;

const SQL_CHANNEL_LABEL = `coalesce(
  nullif(btrim(channel.title), ''),
  case
    when nullif(btrim(regexp_replace(coalesce(channel.handle, ''), '^@', '')), '') is not null
      then '@' || btrim(regexp_replace(coalesce(channel.handle, ''), '^@', ''))
    when channel.network = 'vk' then 'VK'
    when channel.network = 'tg' then 'Telegram'
    else 'Без канала'
  end
)`;

function sqlStatusLabel(column: string): string {
  const cases = Object.entries(CONTENT_STATUS)
    .map(([status, label]) => `when '${status.replaceAll("'", "''")}' then '${label.replaceAll("'", "''")}'`)
    .join(" ");
  return `(case ${column} ${cases} else coalesce(${column}, '') end)`;
}

type SqlFilterExpressions = Record<FilterKey, string>;

function appendSqlFilters(
  parameters: unknown[],
  filters: NormalizedFilters,
  expressions: SqlFilterExpressions,
): string {
  const conditions: string[] = [];
  for (const key of FILTER_KEYS) {
    if (filters[key].length === 0) continue;
    parameters.push(filters[key].map((value) => value.toLocaleLowerCase("ru-RU")));
    conditions.push(`lower(btrim(${expressions[key]})) = any($${parameters.length}::text[])`);
  }
  return conditions.length > 0 ? `\n          and ${conditions.join("\n          and ")}` : "";
}

function postFilterExpressions(statusColumn = "post.status"): SqlFilterExpressions {
  return {
    channel: SQL_CHANNEL_LABEL,
    author: `coalesce(nullif(btrim(author.name), ''), 'Не указан')`,
    campaign: `coalesce(nullif(btrim(campaign_item.campaign_name), ''), '')`,
    status: sqlStatusLabel(statusColumn),
  };
}

function campaignItemFilterExpressions(): SqlFilterExpressions {
  return {
    channel: SQL_CHANNEL_LABEL,
    author: `coalesce(nullif(btrim(author.name), ''), 'Не указан')`,
    campaign: `coalesce(nullif(btrim(campaign.goal), ''), '')`,
    status: sqlStatusLabel("item.approval_status"),
  };
}

async function loadSourceRows(
  db: Queryable,
  projectId: number,
  kind: ProjectExportKind,
  period: { from: string; to: string },
  timezone: string,
  filters: NormalizedFilters,
) {
  if (kind === "content_plan") {
    const postParameters: unknown[] = [projectId, timezone, period.from, period.to];
    const postFilters = appendSqlFilters(postParameters, filters, postFilterExpressions());
    postParameters.push(MAX_SOURCE_ROWS + 1);
    const posts = await db.query(
      `select post.id, post.project_id, post.text, post.status,
              coalesce(post.scheduled_at, post.published_at, post.created_at) as occurred_at,
              post.external_message_id, post.tg_message_id, post.vk_post_id,
              channel.network, channel.title as channel_title, channel.handle, channel.vk_group_id,
              author.name as author_name,
              campaign_item.title as campaign_title, campaign_item.rubric,
              campaign_item.campaign_name,
              coalesce(campaign_item.approver_name, editorial_approval.approver_name) as approver_name,
              tracking.destination_url, tracking.short_url_path, tracking.utm_values
         from posts post
         ${COMMON_POST_JOINS}
        where post.project_id = $1
          and (coalesce(post.scheduled_at, post.published_at, post.created_at) at time zone $2)::date
              between $3::date and $4::date
          ${postFilters}
        order by coalesce(post.scheduled_at, post.published_at, post.created_at), post.id
        limit $${postParameters.length}`,
      postParameters,
    );
    const itemParameters: unknown[] = [projectId, timezone, period.from, period.to];
    const itemFilters = appendSqlFilters(itemParameters, filters, campaignItemFilterExpressions());
    itemParameters.push(MAX_SOURCE_ROWS + 1);
    const campaignItems = await db.query(
      `select ('campaign-' || item.id::text) as id, item.project_id, item.title as text,
              item.approval_status as status,
              (item.scheduled_for::timestamp at time zone $2) as occurred_at,
              null::text as external_message_id, null::bigint as tg_message_id,
              null::bigint as vk_post_id,
              channel.network, channel.title as channel_title, channel.handle, channel.vk_group_id,
              author.name as author_name,
              item.title as campaign_title, item.rubric, campaign.goal as campaign_name,
              approver.name as approver_name,
              null::text as destination_url, null::text as short_url_path, null::jsonb as utm_values
         from monthly_campaign_items item
         join monthly_campaign_plans plan
           on plan.id = item.plan_id and plan.project_id = item.project_id
         join monthly_campaigns campaign
           on campaign.id = plan.campaign_id and campaign.project_id = item.project_id
         left join users author on author.id = campaign.created_by_user_id
         left join users approver on approver.id = plan.approved_by_user_id
         left join autopilot_plan weekly
           on weekly.id = item.weekly_autopilot_plan_id and weekly.project_id = item.project_id
         left join channels channel
           on channel.id = weekly.channel_id and channel.project_id = item.project_id
        where item.project_id = $1 and item.post_id is null
          and item.scheduled_for between $3::date and $4::date
          ${itemFilters}
        order by item.scheduled_for, item.position, item.id
        limit $${itemParameters.length}`,
      itemParameters,
    );
    return [...posts.rows, ...campaignItems.rows]
      .sort((left, right) => {
        const time = new Date(left.occurred_at).getTime() - new Date(right.occurred_at).getTime();
        return time || String(left.id).localeCompare(String(right.id));
      })
      .slice(0, MAX_SOURCE_ROWS + 1) as Record<string, unknown>[];
  }
  const analyticsParameters: unknown[] = [projectId, timezone, period.from, period.to];
  const analyticsFilters = appendSqlFilters(
    analyticsParameters,
    filters,
    postFilterExpressions("'confirmed'"),
  );
  analyticsParameters.push(MAX_SOURCE_ROWS + 1);
  const result = await db.query(
    `select post.id, post.project_id, post.text, 'confirmed' as status, post.published_at as occurred_at,
            post.external_message_id, post.tg_message_id, post.vk_post_id,
            channel.network, channel.title as channel_title, channel.handle, channel.vk_group_id,
            author.name as author_name,
            campaign_item.title as campaign_title, campaign_item.rubric,
            campaign_item.campaign_name,
            coalesce(campaign_item.approver_name, editorial_approval.approver_name) as approver_name,
            tracking.short_url_path,
            latest_stats.views, latest_stats.reactions, latest_stats.comments, latest_stats.reposts,
            case when tracking.short_link_id is null then null else clicks.total end as clicks_total,
            case when tracking.short_link_id is null then null else clicks.unique_total end as clicks_unique,
            case when tracking.short_link_id is null then null else conversions.total end as conversions,
            coalesce(tracker.status, 'not_connected') as tracker_state
       from posts post
       ${COMMON_POST_JOINS}
       left join lateral (
         select stats.views, stats.reactions, stats.comments, stats.reposts
           from post_stats stats
          where stats.project_id = post.project_id and stats.post_id = post.id
          order by stats.snapshot_date desc, stats.collected_at desc, stats.id desc limit 1
       ) latest_stats on true
       left join lateral (
         select count(*) filter (where not click.is_likely_bot)::bigint as total,
                count(*) filter (where not click.is_likely_bot and click.is_unique)::bigint as unique_total
           from short_link_clicks click
          where click.project_id = post.project_id and click.short_link_id = tracking.short_link_id
            and (click.occurred_at at time zone $2)::date between $3::date and $4::date
       ) clicks on true
       left join lateral (
         select count(*)::bigint as total
           from conversion_events conversion
          where conversion.project_id = post.project_id and conversion.short_link_id = tracking.short_link_id
            and (conversion.occurred_at at time zone $2)::date between $3::date and $4::date
       ) conversions on true
       left join project_tracking_settings tracker on tracker.project_id = post.project_id
      where post.project_id = $1 and post.status = 'published' and post.verification_state = 'verified'
        and (post.published_at at time zone $2)::date between $3::date and $4::date
        ${analyticsFilters}
      order by post.published_at, post.id
      limit $${analyticsParameters.length}`,
    analyticsParameters,
  );
  return result.rows as Record<string, unknown>[];
}

function mapSourceRows(
  rows: Record<string, unknown>[],
  projectId: number,
  timezone: string,
  kind: ProjectExportKind,
) {
  return rows
  .filter((row) => positiveId(row.project_id) === projectId)
  .map((row) => {
    const common = commonRow(row, projectId);
    if (kind === "content_plan") return {
      ...common,
      scheduledAt: iso(row.occurred_at),
      timezone,
      utmUrl: trackedUrl(row),
    };
    return {
      ...common,
      publishedAt: iso(row.occurred_at),
      confirmed: true,
      views: optionalNumber(row.views),
      reactions: optionalNumber(row.reactions),
      comments: optionalNumber(row.comments),
      shares: optionalNumber(row.reposts),
      clicksTotal: optionalNumber(row.clicks_total),
      clicksUnique: optionalNumber(row.clicks_unique),
      conversions: optionalNumber(row.conversions),
      trackerState: String(row.tracker_state ?? "not_connected"),
    };
  });
}

function projectSelectionPreviewHash(input: {
  projectId: number;
  kind: ProjectExportKind;
  period: { from: string; to: string };
  filters: NormalizedFilters;
  timezone: string;
  rows: ProjectExportSnapshot["rows"];
}): string {
  return projectExportHash({
    schemaVersion: "aurora-project-export-preview-v1",
    projectId: input.projectId,
    kind: input.kind,
    period: input.period,
    filters: input.filters,
    timezone: input.timezone,
    rows: input.rows,
  });
}

async function loadProjectSelection(
  db: Queryable,
  projectId: number,
  request: NormalizedSelection,
) {
  const project = (await db.query(
    `select id, name, timezone from projects where id = $1 and is_archived = false limit 1`,
    [projectId],
  )).rows[0] as Record<string, unknown> | undefined;
  if (!project) throw new ProjectExportServiceError("project_not_found", 404);
  const timezone = String(project.timezone || "UTC");
  const rawRows = await loadSourceRows(
    db,
    projectId,
    request.kind,
    request.period,
    timezone,
    request.filters,
  );
  const mappedRows = mapSourceRows(rawRows, projectId, timezone, request.kind);
  const normalized = createProjectExportSnapshot({
    kind: request.kind,
    exportedAt: "2000-01-01T00:00:00.000Z",
    project: { id: projectId, name: String(project.name), timezone },
    period: request.period,
    filters: request.filters,
    methodology: methodology(request.kind),
    rows: mappedRows,
  });
  const rows = normalized.rows;
  return {
    project,
    timezone,
    rows,
    previewHash: projectSelectionPreviewHash({
      projectId,
      kind: request.kind,
      period: request.period,
      filters: request.filters,
      timezone,
      rows,
    }),
  };
}

export async function previewProjectExport(input: {
  db: Queryable;
  actorUserId: number;
  body: ProjectExportRequest;
}): Promise<ProjectExportPreview> {
  const request = normalizeSelection(input.body);
  const membership = await requireSelectedProjectPermission(input.db, input.actorUserId, "project.read");
  const selection = await loadProjectSelection(input.db, membership.projectId, request);
  return {
    kind: request.kind,
    timezone: selection.timezone,
    period: request.period,
    filters: request.filters,
    rowCount: selection.rows.length,
    exceedsLimit: selection.rows.length > MAX_SOURCE_ROWS,
    previewHash: selection.previewHash,
    sample: selection.rows.slice(0, 5).map((row) => ({
      id: String(row.id ?? ""),
      occurredAt: String("scheduledAt" in row ? row.scheduledAt : row.publishedAt),
      channel: String(row.channel ?? ""),
      title: String(row.title ?? ""),
      status: String(row.status ?? ""),
      author: String(row.author ?? ""),
      campaign: String(row.campaign ?? ""),
    })),
  };
}

function methodology(kind: ProjectExportKind) {
  if (kind === "analytics") {
    return "Только подтверждённые внешние публикации выбранного проекта за период. Метрики сети — последний успешно собранный снимок; клики исключают распознанных ботов, конверсии учитываются только после серверной проверки атрибуции.";
  }
  return "Контент-план выбранного проекта за период в его часовом поясе; применены указанные каналы, авторы, кампании и статусы.";
}

export function shouldQueueProjectExport(snapshot: ProjectExportSnapshot): boolean {
  return snapshot.rows.length > SYNC_ROW_LIMIT
    || Buffer.byteLength(JSON.stringify(snapshot), "utf8") > SYNC_SNAPSHOT_BYTES;
}

function operationView(row: Record<string, unknown>): ProjectExportOperationView {
  return {
    id: Number(row.id),
    kind: row.export_kind as ProjectExportKind,
    format: row.format as ProjectExportFormat,
    status: String(row.status),
    filters: (row.filters ?? {}) as Record<string, unknown>,
    errorCode: row.error_code == null ? null : String(row.error_code),
    errorMessage: row.error_message == null ? null : String(row.error_message),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    completedAt: row.completed_at == null ? null : iso(row.completed_at),
    artifact: row.artifact_id == null ? null : {
      byteSize: Number(row.byte_size),
      fileName: String(row.file_name),
      mimeType: String(row.mime_type),
      expiresAt: iso(row.artifact_expires_at),
    },
  };
}

const OPERATION_VIEW_SELECT = `
  select operation.id, operation.export_kind, operation.format, operation.status,
         operation.filters, operation.error_code, operation.error_message,
         operation.created_at, operation.updated_at, operation.completed_at,
         artifact.id as artifact_id, artifact.file_name, artifact.mime_type,
         artifact.byte_size, artifact.expires_at as artifact_expires_at
    from project_export_operations operation
    left join project_export_artifacts artifact
      on artifact.operation_id = operation.id and artifact.project_id = operation.project_id`;

async function selectExistingOperation(
  db: Queryable,
  projectId: number,
  actorUserId: number,
  requestKey: string,
) {
  return (await db.query(
    `select id, project_id, export_kind, format, request_hash, snapshot_hash, snapshot, status,
            filters, error_code, error_message, created_at, updated_at, completed_at
       from project_export_operations
      where project_id = $1 and requested_by_user_id = $2 and request_key = $3
      limit 1`,
    [projectId, actorUserId, requestKey],
  )).rows[0] as Record<string, unknown> | undefined;
}

function operationIdentity(row: Record<string, unknown>, replayed: boolean) {
  const snapshot = row.snapshot as ProjectExportSnapshot;
  return {
    id: Number(row.id),
    projectId: Number(row.project_id),
    snapshotHash: String(row.snapshot_hash),
    status: String(row.status),
    dispatch: shouldQueueProjectExport(snapshot) ? "queue" as const : "sync" as const,
    replayed,
  };
}

export async function createProjectExportOperation(input: {
  pool: TransactionPool;
  actorUserId: number;
  requestKey: unknown;
  body: ProjectExportRequest;
  requestId?: string | null;
  now?: () => Date;
}) {
  const request = normalizeRequest(input.body, input.requestKey);
  const membership = await requireSelectedProjectPermission(input.pool, input.actorUserId, "project.read");
  const requestHash = projectExportHash({
    projectId: membership.projectId,
    kind: request.kind,
    format: request.format,
    period: request.period,
    filters: request.filters,
  });
  const existing = await selectExistingOperation(
    input.pool,
    membership.projectId,
    input.actorUserId,
    request.requestKey,
  );
  if (existing) {
    if (String(existing.request_hash) !== requestHash) {
      throw new ProjectExportServiceError("idempotency_conflict", 409);
    }
    return operationIdentity(existing, true);
  }

  const selection = await loadProjectSelection(input.pool, membership.projectId, request);
  if (selection.rows.length > MAX_SOURCE_ROWS) throw new ProjectExportServiceError("export_too_large", 413);
  if (selection.previewHash !== request.previewHash) {
    throw new ProjectExportServiceError("preview_stale", 409);
  }
  const exportedAt = (input.now ?? (() => new Date()))();
  const snapshot = createProjectExportSnapshot({
    kind: request.kind,
    exportedAt,
    project: {
      id: membership.projectId,
      name: String(selection.project.name),
      timezone: selection.timezone,
    },
    period: request.period,
    filters: request.filters,
    methodology: methodology(request.kind),
    rows: selection.rows,
  });
  const snapshotHash = projectExportHash(snapshot);
  const client = await input.pool.connect();
  try {
    await client.query("begin");
    const lockedMembership = await requireSelectedProjectPermission(client, input.actorUserId, "project.read");
    if (lockedMembership.projectId !== membership.projectId) {
      throw new ProjectExportServiceError("selected_project_changed", 409);
    }
    const replay = await selectExistingOperation(
      client,
      membership.projectId,
      input.actorUserId,
      request.requestKey,
    );
    if (replay) {
      if (String(replay.request_hash) !== requestHash) {
        throw new ProjectExportServiceError("idempotency_conflict", 409);
      }
      await client.query("commit");
      return operationIdentity(replay, true);
    }
    const inserted = (await client.query(
      `insert into project_export_operations
         (project_id, requested_by_user_id, export_kind, format, request_key, request_hash,
          filters, snapshot, snapshot_hash, status)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, 'pending')
       on conflict (project_id, requested_by_user_id, request_key) do nothing
       returning id, project_id, export_kind, format, request_hash, snapshot_hash, snapshot,
                 status, filters, error_code, error_message, created_at, updated_at, completed_at`,
      [
        membership.projectId,
        input.actorUserId,
        request.kind,
        request.format,
        request.requestKey,
        requestHash,
        JSON.stringify({ period: request.period, ...request.filters }),
        JSON.stringify(snapshot),
        snapshotHash,
      ],
    )).rows[0] as Record<string, unknown> | undefined;
    if (!inserted) {
      const concurrent = await selectExistingOperation(
        client,
        membership.projectId,
        input.actorUserId,
        request.requestKey,
      );
      if (!concurrent || String(concurrent.request_hash) !== requestHash) {
        throw new ProjectExportServiceError("idempotency_conflict", 409);
      }
      await client.query("commit");
      return operationIdentity(concurrent, true);
    }
    await client.query(
      `insert into project_export_outbox (operation_id, project_id, status)
       values ($1, $2, 'pending')`,
      [inserted.id, membership.projectId],
    );
    await client.query(
      `insert into audit_events
         (project_id, actor_user_id, action, entity_type, entity_id, safe_data, request_id, idempotency_key)
       values ($1, $2, 'project.export.requested', 'project_export', $3, $4::jsonb, $5, $6)`,
      [
        membership.projectId,
        input.actorUserId,
        String(inserted.id),
        JSON.stringify({ kind: request.kind, format: request.format, rowCount: snapshot.rows.length,
          dispatch: shouldQueueProjectExport(snapshot) ? "queue" : "sync" }),
        input.requestId ?? null,
        `export:${membership.projectId}:${request.requestKey}`,
      ],
    );
    await client.query("commit");
    return operationIdentity(inserted, false);
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function getProjectExportOperation(
  db: Queryable,
  actorUserId: number,
  operationIdValue: unknown,
) {
  const operationId = positiveId(operationIdValue);
  if (!operationId) throw new ProjectExportServiceError("not_found", 404);
  const membership = await requireSelectedProjectPermission(db, actorUserId, "project.read");
  const row = (await db.query(
    `${OPERATION_VIEW_SELECT}
      where operation.id = $1 and operation.project_id = $2
        and operation.requested_by_user_id = $3
      limit 1`,
    [operationId, membership.projectId, actorUserId],
  )).rows[0] as Record<string, unknown> | undefined;
  if (!row) throw new ProjectExportServiceError("not_found", 404);
  return operationView(row);
}

export async function listProjectExportOperations(
  db: Queryable,
  actorUserId: number,
  limitValue: unknown = 20,
) {
  const membership = await requireSelectedProjectPermission(db, actorUserId, "project.read");
  const limit = Math.max(1, Math.min(100, Number(limitValue) || 20));
  const result = await db.query(
    `${OPERATION_VIEW_SELECT}
      where operation.project_id = $1 and operation.requested_by_user_id = $2
      order by operation.created_at desc, operation.id desc limit $3`,
    [membership.projectId, actorUserId, limit],
  );
  return result.rows.map((row) => operationView(row as Record<string, unknown>));
}

export async function createProjectExportDownloadToken(input: {
  pool: TransactionPool;
  actorUserId: number;
  operationId: unknown;
  now?: () => Date;
}) {
  const operationId = positiveId(input.operationId);
  if (!operationId) throw new ProjectExportServiceError("not_found", 404);
  const now = (input.now ?? (() => new Date()))();
  const membership = await requireSelectedProjectPermission(input.pool, input.actorUserId, "project.read");
  const artifact = (await input.pool.query(
    `select artifact.id, artifact.expires_at
       from project_export_operations operation
       join project_export_artifacts artifact
         on artifact.operation_id = operation.id and artifact.project_id = operation.project_id
      where operation.id = $1 and operation.project_id = $2
        and operation.requested_by_user_id = $3 and operation.status = 'ready'
        and artifact.expires_at > $4
      limit 1`,
    [operationId, membership.projectId, input.actorUserId, now],
  )).rows[0] as Record<string, unknown> | undefined;
  if (!artifact) throw new ProjectExportServiceError("export_not_ready", 409);
  const artifactExpiry = new Date(String(artifact.expires_at));
  const expiresAt = new Date(Math.min(artifactExpiry.getTime(), now.getTime() + DOWNLOAD_TOKEN_TTL_MS));
  if (expiresAt <= now) throw new ProjectExportServiceError("export_expired", 410);
  const token = randomBytes(32).toString("base64url");
  const tokenHash = projectExportHash(token);
  await input.pool.query(
    `insert into project_export_download_tokens
       (project_id, artifact_id, requested_by_user_id, token_hash, expires_at)
     values ($1, $2, $3, $4, $5)`,
    [membership.projectId, artifact.id, input.actorUserId, tokenHash, expiresAt],
  );
  return { token, expiresAt: expiresAt.toISOString() };
}

export async function resolveProjectExportDownload(input: {
  pool: TransactionPool;
  actorUserId: number;
  operationId: unknown;
  token: unknown;
  now?: () => Date;
}) {
  const operationId = positiveId(input.operationId);
  const token = String(input.token ?? "");
  if (!operationId || !/^[A-Za-z0-9_-]{43}$/u.test(token)) {
    throw new ProjectExportServiceError("download_not_found", 404);
  }
  const now = (input.now ?? (() => new Date()))();
  const tokenHash = projectExportHash(token);
  const client = await input.pool.connect();
  try {
    await client.query("begin");
    const membership = await requireSelectedProjectPermission(client, input.actorUserId, "project.read");
    const row = (await client.query(
      `select token.id as token_id, artifact.file_name, artifact.mime_type,
              artifact.byte_size, artifact.storage_backend, artifact.data
         from project_export_download_tokens token
         join project_export_artifacts artifact
           on artifact.id = token.artifact_id and artifact.project_id = token.project_id
         join project_export_operations operation
           on operation.id = artifact.operation_id and operation.project_id = artifact.project_id
        where operation.id = $1 and operation.project_id = $2
          and operation.requested_by_user_id = $3 and operation.status = 'ready'
          and token.requested_by_user_id = $3 and token.token_hash = $4
          and token.revoked_at is null and token.expires_at > $5 and artifact.expires_at > $5
        limit 1 for update of token`,
      [operationId, membership.projectId, input.actorUserId, tokenHash, now],
    )).rows[0] as Record<string, unknown> | undefined;
    if (!row || row.storage_backend !== "postgres" || !Buffer.isBuffer(row.data)) {
      throw new ProjectExportServiceError("download_not_found", 404);
    }
    const byteSize = Number(row.byte_size);
    if (byteSize < 0 || byteSize > MAX_ARTIFACT_BYTES || row.data.byteLength !== byteSize) {
      throw new ProjectExportServiceError("download_not_found", 404);
    }
    await client.query(
      `update project_export_download_tokens set last_downloaded_at = $2 where id = $1`,
      [row.token_id, now],
    );
    await client.query("commit");
    return {
      bytes: Buffer.from(row.data),
      fileName: String(row.file_name),
      mimeType: String(row.mime_type),
    };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function revokeProjectExportOperation(input: {
  pool: TransactionPool;
  actorUserId: number;
  operationId: unknown;
}) {
  const operationId = positiveId(input.operationId);
  if (!operationId) throw new ProjectExportServiceError("not_found", 404);
  const client = await input.pool.connect();
  try {
    await client.query("begin");
    const membership = await requireSelectedProjectPermission(client, input.actorUserId, "project.read");
    const updated = await client.query(
      `update project_export_operations
          set status = 'expired', updated_at = now(), completed_at = coalesce(completed_at, now())
        where id = $1 and project_id = $2 and requested_by_user_id = $3
          and status <> 'expired'
        returning id`,
      [operationId, membership.projectId, input.actorUserId],
    );
    if (!updated.rows[0]) {
      const exists = await client.query(
        `select id from project_export_operations
          where id = $1 and project_id = $2 and requested_by_user_id = $3`,
        [operationId, membership.projectId, input.actorUserId],
      );
      if (!exists.rows[0]) throw new ProjectExportServiceError("not_found", 404);
    }
    await client.query(
      `update project_export_outbox
          set status = 'cancelled', lease_token = null, lease_expires_at = null, updated_at = now()
        where operation_id = $1 and project_id = $2`,
      [operationId, membership.projectId],
    );
    await client.query(
      `update project_export_download_tokens token
          set revoked_at = coalesce(token.revoked_at, now())
         from project_export_artifacts artifact
        where artifact.id = token.artifact_id and artifact.project_id = token.project_id
          and artifact.operation_id = $1 and token.project_id = $2`,
      [operationId, membership.projectId],
    );
    if (updated.rows[0]) {
      await client.query(
        `insert into audit_events
           (project_id, actor_user_id, action, entity_type, entity_id, safe_data, idempotency_key)
         values ($1, $2, 'project.export.revoked', 'project_export', $3, '{}'::jsonb, $4)
         on conflict (project_id, idempotency_key) where idempotency_key is not null do nothing`,
        [
          membership.projectId,
          input.actorUserId,
          String(operationId),
          `export-revoke:${membership.projectId}:${operationId}`,
        ],
      );
    }
    await client.query("commit");
    return { id: operationId, status: "expired" as const };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
