import type { Pool } from "pg";

type Queryable = Pick<Pool, "query">;

export interface AdminAuditQuery {
  query: string;
  projectId: number | null;
  actorId: number | null;
  /** First segment of `audit_events.action`, e.g. `publication` or `project`. */
  area: string;
  page: number;
  pageSize: number;
}

export interface AdminAuditItem {
  id: number;
  action: string;
  entityType: string;
  entityId: string | null;
  projectId: number;
  project: string;
  actorId: number | null;
  actor: string;
  requestId: string | null;
  /** Scalar-only, already stripped of content by the writers; shown as-is. */
  safeData: Record<string, string | number | boolean | null>;
  createdAt: string;
}

export interface AdminAuditResponse {
  items: AdminAuditItem[];
  pagination: { page: number; pageSize: number; total: number; pages: number };
  options: {
    areas: string[];
    projects: Array<{ id: number; label: string }>;
    actors: Array<{ id: number; label: string }>;
  };
}

const SAFE_AREA = /^[a-z_]{1,40}$/u;

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

function scalarData(value: unknown): AdminAuditItem["safeData"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: AdminAuditItem["safeData"] = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 12)) {
    if (item === null || ["string", "number", "boolean"].includes(typeof item)) {
      result[key] = typeof item === "string" ? item.slice(0, 120) : item as string | number | boolean | null;
    }
  }
  return result;
}

export function normalizeAdminAuditQuery(params: URLSearchParams): AdminAuditQuery {
  const area = String(params.get("area") ?? "").trim().toLowerCase();
  const page = Number(params.get("page") ?? "1");
  return {
    query: String(params.get("q") ?? "").trim().slice(0, 200),
    projectId: positiveId(params.get("project")) || null,
    actorId: positiveId(params.get("actor")) || null,
    area: SAFE_AREA.test(area) ? area : "",
    page: Number.isSafeInteger(page) && page > 0 ? Math.min(page, 10_000) : 1,
    pageSize: 50,
  };
}

export async function loadAdminAudit(db: Queryable, input: AdminAuditQuery): Promise<AdminAuditResponse> {
  const offset = (input.page - 1) * input.pageSize;
  const search = `%${input.query.replace(/[%_\\]/gu, (char) => `\\${char}`)}%`;
  const [rows, options] = await Promise.all([
    db.query<Record<string, unknown>>(
      `select event.id, event.action, event.entity_type, event.entity_id, event.project_id,
              event.actor_user_id, event.request_id, event.safe_data, event.created_at,
              project.name as project,
              coalesce(nullif(btrim(actor.name), ''), actor.email, 'Системное действие') as actor,
              count(*) over() as filtered_total
         from audit_events event
         join projects project on project.id = event.project_id
         left join users actor on actor.id = event.actor_user_id
        where ($1::text = ''
               or event.action ilike $2
               or coalesce(event.entity_id, '') = $1
               or project.name ilike $2
               or coalesce(actor.name, '') ilike $2
               or coalesce(actor.email, '') ilike $2)
          and ($3::bigint is null or event.project_id = $3)
          and ($4::bigint is null or event.actor_user_id = $4)
          and ($5::text = '' or split_part(event.action, '.', 1) = $5)
        order by event.created_at desc, event.id desc
        limit $6 offset $7`,
      [input.query, search, input.projectId, input.actorId, input.area, input.pageSize, offset],
    ),
    db.query<{ areas: string[] | null; projects: Array<{ id: number | string; label: string }> | null; actors: Array<{ id: number | string; label: string }> | null }>(
      `select
         (select array_agg(distinct split_part(event.action, '.', 1) order by split_part(event.action, '.', 1))
            from audit_events event where event.created_at >= now() - interval '180 days') as areas,
         (select json_agg(json_build_object('id', project.id, 'label', project.name) order by project.name)
            from projects project
           where exists (select 1 from audit_events event where event.project_id = project.id)) as projects,
         (select json_agg(json_build_object('id', actor.id, 'label', coalesce(nullif(btrim(actor.name), ''), actor.email, 'Пользователь ' || actor.id::text)) order by actor.id)
            from users actor
           where exists (select 1 from audit_events event where event.actor_user_id = actor.id
                          and event.created_at >= now() - interval '180 days')) as actors`,
    ),
  ]);
  const total = count(rows.rows[0]?.filtered_total);
  const option = options.rows[0];
  return {
    items: rows.rows.map((row) => ({
      id: positiveId(row.id),
      action: String(row.action),
      entityType: String(row.entity_type),
      entityId: row.entity_id == null ? null : String(row.entity_id),
      projectId: positiveId(row.project_id),
      project: String(row.project || "Проект"),
      actorId: row.actor_user_id == null ? null : positiveId(row.actor_user_id),
      actor: String(row.actor || "Системное действие"),
      requestId: row.request_id == null ? null : String(row.request_id),
      safeData: scalarData(row.safe_data),
      createdAt: iso(row.created_at),
    })),
    pagination: { page: input.page, pageSize: input.pageSize, total, pages: Math.max(1, Math.ceil(total / input.pageSize)) },
    options: {
      areas: option?.areas ?? [],
      projects: (option?.projects ?? []).map((project) => ({ id: positiveId(project.id), label: String(project.label) })),
      actors: (option?.actors ?? []).map((actor) => ({ id: positiveId(actor.id), label: String(actor.label) })),
    },
  };
}
