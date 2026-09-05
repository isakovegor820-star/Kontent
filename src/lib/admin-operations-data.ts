import type { Pool } from "pg";
import { normalizeAdminPeriod } from "./admin-dashboard";

type Db = Pick<Pool, "query">;
export function operationsQuery(params: URLSearchParams) {
  const rawPage = Number(params.get("page"));
  return { query: (params.get("q") || "").trim().slice(0, 200), status: params.get("status") || "all",
    days: normalizeAdminPeriod(params.get("days")), page: Number.isSafeInteger(rawPage) && rawPage > 0 ? Math.min(rawPage, 100_000) : 1 };
}
function pagination(total: number, requested: number) {
  const pages = Math.max(1, Math.ceil(total / 20));
  return { total, page: Math.min(requested, pages), pages, pageSize: 20 };
}

export async function loadAdminConnections(db: Db, params: URLSearchParams) {
  const q = operationsQuery(params);
  const where = `from channels c join users u on u.id=c.user_id left join projects p on p.id=c.project_id
    where ($1='' or concat_ws(' ',c.id::text,c.title,c.handle,u.name,u.email,p.name,c.network) ilike '%' || $1 || '%')
      and ($2='all' or ($2='attention' and c.is_active and c.status<>'active')
        or ($2='active' and c.is_active and c.status='active') or ($2='disconnected' and (not c.is_active or c.status='disconnected')))`;
  const status = ["all", "attention", "active", "disconnected"].includes(q.status) ? q.status : "all";
  const values = [q.query, status];
  const count = await db.query<{ total: number }>(`select count(*)::int as total ${where}`, values);
  const page = pagination(count.rows[0]?.total ?? 0, q.page);
  const rows = await db.query<{ id: number; title: string; handle: string | null; network: string; status: string; active: boolean; userId: number; user: string; project: string; errorCode: string | null; errorAt: string | null; updatedAt: string }>(
    `select c.id::int,coalesce(c.title,'Канал без названия') as title,c.handle,c.network,c.status,c.is_active as active,
      u.id::int as "userId",coalesce(u.name,u.email,'Аккаунт '||u.id) as "user",coalesce(p.name,'Без проекта') as project,
      c.last_auth_error_code as "errorCode",c.last_auth_error_at as "errorAt",c.updated_at as "updatedAt"
      ${where} order by (c.is_active and c.status<>'active') desc,c.updated_at desc,c.id desc limit 20 offset $3`, [...values, (page.page - 1) * 20]);
  return { checkedAt: new Date().toISOString(), items: rows.rows, pagination: page };
}
export type AdminConnectionsData = Awaited<ReturnType<typeof loadAdminConnections>>;

export async function loadAdminAiSpend(db: Db, params: URLSearchParams) {
  const q = operationsQuery(params);
  const ledger = await db.query<{ available: boolean }>("select to_regclass('public.ai_spend_attempts') is not null as available");
  if (!ledger.rows[0]?.available) {
    return { availability: "not_configured" as const, checkedAt: new Date().toISOString(), periodDays: q.days };
  }
  const status = ["all", "unknown", "failed"].includes(q.status) ? q.status : "all";
  // All monetary values stay integer microUSD strings; no inferred tariffs or billing totals.
  const from = `from ai_spend_attempts a join projects p on p.id=a.project_id
    where a.budget_date >= (now() at time zone 'UTC')::date - ($1::int - 1)
      and a.budget_date <= (now() at time zone 'UTC')::date
      and ($2='' or concat_ws(' ',a.provider,a.model,p.name,p.id::text) ilike '%' || $2 || '%')
      and ($3='all' or ($3='unknown' and not a.usage_known) or ($3='failed' and a.status='failed'))`;
  const values = [q.days, q.query, status];
  const totals = await db.query<{ attempts: number; unknown: number; failed: number; knownMicrousd: string; reservedMicrousd: string }>(
    `select count(*)::int as attempts,count(*) filter(where not usage_known)::int as unknown,
      count(*) filter(where a.status='failed')::int as failed,
      coalesce(sum(charged_microusd) filter(where usage_known),0)::text as "knownMicrousd",
      coalesce(sum(coalesce(charged_microusd,reserved_microusd)) filter(where not usage_known),0)::text as "reservedMicrousd" ${from}`, values);
  const count = await db.query<{ total: number }>(`select count(*)::int as total from (select a.provider,a.model,a.project_id ${from} group by a.provider,a.model,a.project_id) groups`, values);
  const page = pagination(count.rows[0]?.total ?? 0, q.page);
  const rows = await db.query<{ provider: string; model: string; projectId: number; project: string; attempts: number; unknown: number; failed: number; knownMicrousd: string; reservedMicrousd: string }>(
    `select a.provider,a.model,a.project_id::int as "projectId",p.name as project,count(*)::int as attempts,
      count(*) filter(where not usage_known)::int as unknown,count(*) filter(where a.status='failed')::int as failed,
      coalesce(sum(charged_microusd) filter(where usage_known),0)::text as "knownMicrousd",
      coalesce(sum(coalesce(charged_microusd,reserved_microusd)) filter(where not usage_known),0)::text as "reservedMicrousd"
      ${from} group by a.provider,a.model,a.project_id,p.name
      order by sum(coalesce(charged_microusd,reserved_microusd)) desc,a.project_id,a.provider,a.model limit 20 offset $4`, [...values, (page.page - 1) * 20]);
  return { availability: "ready" as const, checkedAt: new Date().toISOString(), periodDays: q.days, summary: totals.rows[0], items: rows.rows, pagination: page };
}
export type AdminAiSpendData = Awaited<ReturnType<typeof loadAdminAiSpend>>;
