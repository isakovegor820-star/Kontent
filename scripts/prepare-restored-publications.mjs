import pg from "pg";
import { pathToFileURL } from "node:url";

export function assertRestoredDatabaseTarget(databaseUrl, apply) {
  if (!databaseUrl) throw new Error("RESTORE_DATABASE_URL is required; application .env is never loaded");
  const target = new URL(databaseUrl);
  if (apply && (!["localhost", "127.0.0.1", "[::1]"].includes(target.hostname)
    || !/^\/aurora_[a-z0-9_]+_restore_test$/u.test(target.pathname))) {
    throw new Error("apply is restricted to an explicitly named disposable localhost aurora_*_restore_test database");
  }
}

const TARGETS = [
  ["posts", "status in ('scheduled','failed_retry','publishing','quarantined')", `status = 'published_unverified', schedule_revision = schedule_revision + 1,
    verification_state = 'unverified', verification_error_code = 'restored_delivery_unknown',
    verification_error_reason = 'Внешние действия после снимка БД требуют сверки',
    verification_result = '{"result":"delivery_unknown","source":"restore_quarantine"}'::jsonb,
    last_error = 'Отправка остановлена после восстановления БД до сверки',
    provider_reconciliation_state = 'unresolved', publish_lease_token = null, next_attempt_at = null`],
  ["publication_parts", "send_status in ('pending','failed','sending') and external_message_id is null", "send_status = 'unknown', last_error_code = 'restored_delivery_unknown', updated_at = now()"],
  ["site_article_publications", "status in ('pending','publishing')", "status = 'published_unverified', outcome = 'delivery_unknown', reconcile_state = 'unresolved', last_error_code = 'restored_delivery_unknown', worker_lease_token = null, updated_at = now()"],
  ["publication_extra_operations", "status in ('pending','queued','failed_retry','running')", "status = 'failed', last_error_code = 'delivery_unknown', last_error_message = 'Восстановленная операция требует ручной сверки', lease_token = null, lease_expires_at = null, completed_at = now(), updated_at = now()"],
  ["bot_client_inquiries", "status = 'approved'", "status = 'failed', delivery_error_code = 'delivery_unknown', version = version + 1, updated_at = now()"],
  ["publication_review_tasks", "reminder_status in ('pending','sending')", "reminder_status = 'failed', reminder_last_error_code = 'delivery_unknown', version = version + 1, updated_at = now()"],
  ["admin_alert_notifications", "completed_at is null and superseded_at is null", "superseded_at = now()"],
  ["admin_alert_deliveries", "send_status in ('pending','sending','rejected')", "send_status = 'unknown', last_error_code = 'restored_delivery_unknown', updated_at = now()"],
  ["telegram_update_deliveries", "send_status in ('sending','rejected')", "send_status = 'unknown', updated_at = now()"],
  ["telegram_background_deliveries", "send_status in ('sending','rejected')", "send_status = 'unknown', updated_at = now()"],
];

export async function quarantineRestoredPublications(pool, { apply = false } = {}) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    if (apply) await client.query("set local lock_timeout = '5s'");
    const report = {};
    for (const [table, predicate, mutation] of TARGETS) {
      const exists = (await client.query("select to_regclass($1) as name", [`public.${table}`])).rows[0].name;
      if (!exists) { report[table] = { absent: true }; continue; }
      const before = Number((await client.query(`select count(*) as count from ${table} where ${predicate}`)).rows[0].count);
      const changed = apply ? (await client.query(`update ${table} set ${mutation} where ${predicate}`)).rowCount : 0;
      report[table] = { candidates: before, changed };
    }
    await client.query(apply ? "commit" : "rollback");
    return { mode: apply ? "apply_disposable_restore" : "dry_run", report, resumeAllowed: false };
  } catch (error) {
    await client.query("rollback").catch(() => {}); throw error;
  } finally { client.release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const apply = process.argv.includes("--apply");
  if (process.argv.slice(2).some((argument) => argument !== "--apply")) throw new Error("only --apply is accepted; default is read-only");
  const databaseUrl = process.env.RESTORE_DATABASE_URL;
  assertRestoredDatabaseTarget(databaseUrl, apply);
  if (apply && process.env.AURORA_OUTBOUND_DISABLED !== "1") throw new Error("AURORA_OUTBOUND_DISABLED=1 is required before restore quarantine");
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try { console.log(JSON.stringify(await quarantineRestoredPublications(pool, { apply }), null, 2)); }
  finally { await pool.end(); }
}
