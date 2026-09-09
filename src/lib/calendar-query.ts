import { createHash } from "node:crypto";
import { Temporal } from "@js-temporal/polyfill";
import type { PoolClient } from "pg";

export class CalendarQueryError extends Error {
  constructor() { super("invalid_calendar_query"); }
}
export type CalendarPage = { hasMore: boolean; nextCursor: string | null };
export type CalendarSelection = { view?: "range" | "undated" | "attention"; from?: string; to?: string; timezone?: string };

/** Local date interval [from, to), including midnight transitions and 23/25-hour days. */
export function calendarRange(from: string, to: string, timezone: string) {
  try {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(from) || !/^\d{4}-\d{2}-\d{2}$/u.test(to)) throw new Error();
    const start = Temporal.PlainDate.from(from), end = Temporal.PlainDate.from(to);
    const days = start.until(end).days;
    if (days < 1 || days > 62) throw new Error();
    return { from: start.toZonedDateTime(timezone).toInstant().toString(), to: end.toZonedDateTime(timezone).toInstant().toString() };
  } catch { throw new CalendarQueryError(); }
}

export async function calendarQuery(db: Pick<PoolClient, "query">, projectId: number, resource: "posts" | "drafts", params: URLSearchParams) {
  const keys = ["view", "from", "to", "cursor", "limit", "id", "timezone"];
  if (keys.some(key => params.getAll(key).length > 1)) throw new CalendarQueryError();
  const view = params.get("view") ?? "all";
  if (!["all", "range", "undated", "attention"].includes(view)) throw new CalendarQueryError();
  const limitText = params.get("limit") ?? "200";
  const limit = Number(limitText);
  if (!/^\d+$/u.test(limitText) || !Number.isInteger(limit) || limit < 1 || limit > 200) throw new CalendarQueryError();
  if (view !== "range" && (params.has("from") || params.has("to") || params.has("timezone"))) throw new CalendarQueryError();
  const alias = resource === "posts" ? "p" : "d";
  const values: unknown[] = [projectId];
  const bind = (value: unknown) => { values.push(value); return `$${values.length}`; };
  let condition = "";
  let timezone = "";
  if (view === "range") {
    timezone = (await db.query<{ timezone: string }>("select timezone from projects where id = $1", [projectId])).rows[0]?.timezone;
    if (!timezone || (params.has("timezone") && params.get("timezone") !== timezone)) throw new CalendarQueryError();
    const range = calendarRange(params.get("from") ?? "", params.get("to") ?? "", timezone);
    condition += ` and ${alias}.scheduled_at >= ${bind(range.from)}::timestamptz and ${alias}.scheduled_at < ${bind(range.to)}::timestamptz`;
  }
  if (view === "undated") condition += ` and ${alias}.scheduled_at is null`;
  if (view === "attention") condition += resource === "posts"
    ? " and (p.status in ('failed', 'failed_retry', 'quarantined', 'published_unverified', 'missing', 'deleted_external') or p.quarantined_at is not null or p.verification_state = 'missing' or p.publication_operation_id in (select id from publication_operations where project_id = $1 and status in ('failed', 'published_unverified', 'partial')))"
    : " and editorial_workflow.state = 'changes_requested'";
  const idText = params.get("id");
  if (idText != null) {
    if (view !== "all" || !/^[1-9]\d*$/u.test(idText) || !Number.isSafeInteger(Number(idText))) throw new CalendarQueryError();
    condition += ` and ${alias}.id = ${bind(Number(idText))}`;
  }
  const signature = createHash("sha256").update(JSON.stringify([resource, projectId, view, params.get("from"), params.get("to"), timezone, idText])).digest("hex");
  let upper: number | null = null;
  const cursor = params.get("cursor");
  if (cursor != null) {
    try {
      if (cursor.length > 512) throw new Error();
      const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
      if (decoded.scope !== signature || !Number.isSafeInteger(decoded.before) || !Number.isSafeInteger(decoded.upper) || decoded.before < 1 || decoded.before > decoded.upper) throw new Error();
      upper = decoded.upper;
      condition += ` and ${alias}.id < ${bind(decoded.before)} and ${alias}.id <= ${bind(upper)}`;
    } catch { throw new CalendarQueryError(); }
  }
  const tail = `${condition} order by ${alias}.id desc limit ${bind(limit + 1)}`;
  return { values, tail, page<T extends { id: number | string }>(rows: T[]): { items: T[] } & CalendarPage {
    const items = rows.slice(0, limit), hasMore = rows.length > limit;
    const nextCursor = hasMore ? Buffer.from(JSON.stringify({ scope: signature, upper: upper ?? Number(items[0].id), before: Number(items.at(-1)!.id) })).toString("base64url") : null;
    return { items, hasMore, nextCursor };
  } };
}
