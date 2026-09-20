import type { Pool } from "pg";
import type { AdminAlertCondition, AdminAlertNotification } from "./admin-alerts";

export type StoredAdminAlertNotification = AdminAlertNotification & { eventId: number };
type EventRow = { id: string | number; alert_id: AdminAlertCondition["id"]; kind: AdminAlertNotification["kind"]; severity: AdminAlertCondition["severity"]; detail: string; since_ms: string | number; completed_at: Date | null; superseded_at: Date | null };
const notification = (row: EventRow): StoredAdminAlertNotification => ({ eventId: Number(row.id), id: row.alert_id, kind: row.kind, severity: row.severity, detail: row.detail, sinceMs: Number(row.since_ms) });

/** Shared transition identity across web processes. Cooldown begins only at confirmation. */
export class AdminAlertTracker {
  readonly #pool: Pick<Pool, "connect">;
  readonly #repeatMs: number;
  constructor(options: { pool: Pick<Pool, "connect">; repeatMs: number }) {
    this.#pool = options.pool; this.#repeatMs = options.repeatMs;
  }
  async transition(conditions: readonly AdminAlertCondition[], nowMs = Date.now()): Promise<StoredAdminAlertNotification[]> {
    const client = await this.#pool.connect();
    const result: StoredAdminAlertNotification[] = [];
    const now = new Date(nowMs);
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(hashtext('aurora:admin-alert-state'))");
      for (const condition of conditions) {
        await client.query("insert into admin_alert_conditions(alert_id,firing,since_ms) values($1,false,$2) on conflict do nothing", [condition.id, nowMs]);
        const previous = (await client.query<{ firing: boolean; generation: string; since_ms: string; current_notification_id: string | null }>(
          "select firing,generation,since_ms,current_notification_id from admin_alert_conditions where alert_id=$1 for update", [condition.id],
        )).rows[0];
        const pending = previous.current_notification_id ? (await client.query<EventRow>("select * from admin_alert_notifications where id=$1", [previous.current_notification_id])).rows[0] : null;
        const changed = previous.firing !== condition.firing;
        const reminder = condition.firing && pending?.completed_at != null && !pending.superseded_at && nowMs - new Date(pending.completed_at).getTime() >= this.#repeatMs;
        if (changed || reminder) {
          if (changed && pending && !pending.completed_at) await client.query("update admin_alert_notifications set superseded_at=$2 where id=$1 and completed_at is null", [pending.id, now]);
          const kind = changed ? condition.firing ? "fired" : "recovered" : "still_firing";
          const sinceMs = changed && condition.firing ? nowMs : Number(previous.since_ms);
          const event = (await client.query<EventRow>(
            `insert into admin_alert_notifications(alert_id,generation,kind,severity,detail,since_ms,created_at)
             values($1,$2,$3,$4,$5,$6,$7) returning *`,
            [condition.id, Number(previous.generation) + 1, kind, condition.severity, condition.detail.slice(0, 500), sinceMs, now],
          )).rows[0];
          await client.query("update admin_alert_conditions set firing=$2,generation=generation+1,since_ms=$3,current_notification_id=$4,updated_at=$5 where alert_id=$1", [condition.id, condition.firing, condition.firing ? sinceMs : nowMs, event.id, now]);
          result.push(notification(event));
        } else if (pending && !pending.completed_at && !pending.superseded_at) result.push(notification(pending));
      }
      await client.query("commit"); return result;
    } catch (error) { await client.query("rollback").catch(() => {}); throw error; }
    finally { client.release(); }
  }
}
