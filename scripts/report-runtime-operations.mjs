#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import pg from "pg";

const CAP_NAMES = ["USER_DAILY_MICROUSD", "PROJECT_DAILY_MICROUSD", "GLOBAL_DAILY_MICROUSD", "USER_CONCURRENCY", "PROJECT_CONCURRENCY", "GLOBAL_CONCURRENCY"];
const fixedError = (error) => ["42P01", "42703", "42501", "57014", "55P03", "25006"].includes(error?.code) ? error.code : "query_unavailable";
function positive(value) { const n = Number(value); return Number.isSafeInteger(n) && n > 0 ? String(n) : null; }
export function runtimeAiConfiguration(input = {}) {
  const caps = Object.fromEntries(CAP_NAMES.map(name => [name, positive(input[`AI_SPEND_${name}`])]));
  let entries = [];
  try {
    const parsed = JSON.parse(input.AI_SPEND_TARIFFS_JSON || "");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) entries = Object.values(parsed);
  } catch { /* Raw config and parse errors must not enter output. */ }
  const valid = entries.filter(row => {
    const values = [row?.inputMicrousdPerMillionTokens, row?.outputMicrousdPerMillionTokens, row?.unitMicrousd ?? 0].map(Number);
    return values.every(n => Number.isSafeInteger(n) && n >= 0) && values.some(n => n > 0);
  }).length;
  return { source: "explicit_supplied_configuration", status: CAP_NAMES.every(name => caps[name]) && entries.length > 0 && valid === entries.length ? "configured" : "unconfigured_or_invalid",
    caps, tariffEntries: entries.length, validTariffEntries: valid,
    runtimeConfigurationMatch: "not_verified", thresholdsApproval: "not_verified" };
}

/** One consistent read-only PostgreSQL snapshot. No .env, Redis, provider calls or notifications. */
export async function reportRuntimeOperations({ databaseUrl, aiConfig = {}, windowMinutes = 60 }) {
  let url; try { url = new URL(databaseUrl); } catch { throw new Error("explicit_database_url_required"); }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || !url.pathname.slice(1)) throw new Error("explicit_database_url_required");
  if (!Number.isSafeInteger(windowMinutes) || windowMinutes < 1 || windowMinutes > 10080) throw new Error("invalid_window_minutes");
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5000,
    application_name: "aurora-runtime-operations-readonly", options: "-c default_transaction_read_only=on -c statement_timeout=15000" });
  let client;
  try {
    client = await pool.connect();
    await client.query("begin isolation level repeatable read read only");
    await client.query("set local statement_timeout='15s'");
    await client.query("set local lock_timeout='2s'");
    const info = (await client.query("select now() as captured_at, current_setting('transaction_read_only')='on' as read_only, (now() at time zone 'UTC')::date::text as budget_date")).rows[0];
    if (!info.read_only) throw new Error("read_only_required");
    const query = async (sql, params = []) => {
      await client.query("savepoint snapshot_section");
      try {
        const result = await client.query(sql, params);
        await client.query("release savepoint snapshot_section");
        return { status: "available", rows: result.rows };
      } catch (error) {
        await client.query("rollback to savepoint snapshot_section");
        await client.query("release savepoint snapshot_section");
        return { status: "unavailable", reason: fixedError(error) };
      }
    };
    /** @type {Record<string, any>} */
    const sections = {};
    const report = { schemaVersion: 1, capturedAt: new Date(info.captured_at).toISOString(), readOnly: true,
      observationWindowMinutes: windowMinutes, budgetDateUtc: info.budget_date,
      thresholds: "owner_approval_not_supplied", redisQueueState: "not_observed", oncallReceipt: "not_observed", sections };
    sections.postDelivery = await query(`select
      count(*) filter(where status='quarantined')::text as quarantined,
      count(*) filter(where status='published_unverified')::text as published_unverified,
      count(*) filter(where provider_reconciliation_state in ('pending','unresolved'))::text as unresolved_reconciliation,
      count(*) filter(where status='publishing')::text as publishing,
      count(*) filter(where status in ('scheduled','failed_retry') and scheduled_at<=now())::text as due,
      coalesce(max(greatest(0,extract(epoch from now()-scheduled_at))) filter(where status in ('scheduled','failed_retry') and scheduled_at<=now()),0)::text as oldest_due_seconds
      from posts`);
    sections.publicationParts = await query(`select count(*) filter(where send_status='unknown')::text as unknown,
      count(*) filter(where send_status='sending')::text as sending,
      count(*) filter(where send_status='failed')::text as failed,
      count(*) filter(where send_status='sent')::text as sent from publication_parts`);
    sections.botUpdateDelivery = await query(`select count(*) filter(where send_status='unknown')::text as unknown,
      count(*) filter(where send_status='sending')::text as sending,
      count(*) filter(where send_status='rejected')::text as rejected from telegram_update_deliveries`);
    sections.audienceDelivery = await query(`select count(*) filter(where delivery_error_code='delivery_unknown')::text as unknown,
      count(*) filter(where status='approved' and provider_started_at is not null)::text as admitted_without_terminal_result
      from bot_client_inquiries`);
    sections.siteDelivery = await query(`select count(*) filter(where outcome='delivery_unknown')::text as unknown,
      count(*) filter(where status='publishing')::text as publishing,
      count(*) filter(where status='published_unverified')::text as published_unverified,
      count(*) filter(where reconcile_state in ('pending','unresolved'))::text as unresolved_reconciliation,
      count(*) filter(where outcome='auth_failed' and updated_at>=now()-($1::int*interval '1 minute'))::text as recent_auth_failed
      from site_article_publications`, [windowMinutes]);
    sections.connectionAuth = await query(`select
      (select count(*)::text from channels where status in ('needs_reconnect','permission_lost','revoked')) as channel_access_unavailable,
      (select count(*)::text from channels where last_auth_error_at>=now()-($1::int*interval '1 minute')) as channels_with_recent_auth_error,
      (select count(*)::text from site_destinations where status in ('needs_reconnect','revoked') or credential_state in ('expired','revoked','invalid')) as site_access_unavailable,
      (select count(*)::text from bot_delivery_events where not ok and telegram_error_code in (401,403) and created_at>=now()-($1::int*interval '1 minute')) as recent_bot_auth_errors`, [windowMinutes]);
    sections.signInErrors = { status: "not_observed", reason: "no_complete_durable_signin_failure_series_queried" };
    const outboxes = {};
    for (const table of ["publication_outbox", "publication_extra_outbox", "project_export_outbox", "monthly_campaign_regeneration_outbox", "legal_visual_render_outbox", "publication_review_reminder_outbox"]) {
      outboxes[table] = await query(`select count(*) filter(where status in ('pending','failed','retryable_failed'))::text as waiting,
        count(*) filter(where status in ('pending','failed','retryable_failed') and next_attempt_at<=now())::text as due,
        count(*) filter(where status='dispatching')::text as dispatching,
        count(*) filter(where status='dispatching' and lease_expires_at<=now())::text as expired_leases,
        coalesce(max(greatest(0,extract(epoch from now()-next_attempt_at))) filter(where status in ('pending','failed','retryable_failed') and next_attempt_at<=now()),0)::text as oldest_due_seconds
        from ${table}`);
    }
    outboxes.autopilot_schedule_outbox = await query(`select count(*) filter(where status='pending')::text as waiting,
      coalesce(max(greatest(0,extract(epoch from now()-created_at))) filter(where status='pending'),0)::text as oldest_wait_seconds from autopilot_schedule_outbox`);
    sections.outboxes = outboxes;
    const queued = {};
    for (const [table, active] of [["media_generations", "'queued','submitting','generating','saving'"], ["radar_search_runs", "'queued','running'"], ["site_analysis_jobs", "'queued','crawling','analyzing','planning','saving'"]]) {
      queued[table] = await query(`select count(*) filter(where status='queued')::text as queued,
        count(*) filter(where status in (${active}) and queue_confirmed_at is null)::text as awaiting_queue_confirmation,
        coalesce(max(greatest(0,extract(epoch from now()-updated_at))) filter(where status in (${active})),0)::text as oldest_active_update_age_seconds
        from ${table}`);
    }
    sections.durableQueueJobs = queued;
    const configuration = runtimeAiConfiguration(aiConfig);
    const caps = configuration.caps;
    sections.aiConfiguration = configuration;
    sections.aiSpend = await query(`with daily as (select * from ai_spend_attempts where budget_date=(now() at time zone 'UTC')::date),
      users as (select user_id,sum(coalesce(charged_microusd,reserved_microusd)) as amount from daily group by user_id),
      projects as (select project_id,sum(coalesce(charged_microusd,reserved_microusd)) as amount from daily group by project_id)
      select (select coalesce(sum(coalesce(charged_microusd,reserved_microusd)),0)::text from daily) as daily_accounted_microusd,
      (select count(*)::text from daily where status='failed') as daily_failed_attempts,
      count(*) filter(where status='reserved')::text as reserved_attempts,
      count(*) filter(where status='reserved' and lease_expires_at>now())::text as live_reserved_attempts,
      count(*) filter(where status='reserved' and lease_expires_at<=now())::text as expired_reserved_attempts,
      count(*) filter(where not usage_known)::text as usage_unknown_attempts,
      count(*) filter(where status='unknown')::text as outcome_unknown_attempts,
      coalesce(sum(coalesce(charged_microusd,reserved_microusd)) filter(where not usage_known),0)::text as all_time_unknown_accounted_microusd,
      case when $1::bigint is null then null else (select count(*)::text from users where amount >= $1::bigint) end as users_at_supplied_cap,
      case when $2::bigint is null then null else (select count(*)::text from projects where amount >= $2::bigint) end as projects_at_supplied_cap,
      (select coalesce(sum(coalesce(charged_microusd,reserved_microusd)),0)>=$3::bigint from daily) as at_supplied_global_cap
      from ai_spend_attempts`, [caps.USER_DAILY_MICROUSD, caps.PROJECT_DAILY_MICROUSD, caps.GLOBAL_DAILY_MICROUSD]);
    sections.mediaPolicy = await query(`select user_max_bytes::text,project_max_bytes::text,global_max_bytes::text from media_storage_policy where id=1`);
    if (sections.mediaPolicy.status === "available" && !sections.mediaPolicy.rows.length) sections.mediaPolicy = { status: "unconfigured", rows: [] };
    sections.mediaUsage = await query(`select
      coalesce(sum(bytes_used) filter(where scope='global'),0)::text as global_counter_bytes,
      (select coalesce(sum(greatest(bytes,coalesce(octet_length(data),0))),0)::text from media_assets) as stored_asset_bytes,
      case when not exists(select 1 from media_storage_policy where id=1) then null else count(*) filter(where scope='user' and bytes_used >= (select user_max_bytes from media_storage_policy where id=1))::text end as users_at_policy_cap,
      case when not exists(select 1 from media_storage_policy where id=1) then null else count(*) filter(where scope='project' and bytes_used >= (select project_max_bytes from media_storage_policy where id=1))::text end as projects_at_policy_cap,
      coalesce(sum(bytes_used) filter(where scope='global'),0)>=(select global_max_bytes from media_storage_policy where id=1) as at_global_policy_cap
      from media_storage_usage`);
    sections.mediaOrphans = await query(`select count(*)::text as pending,
      coalesce(max(greatest(0,extract(epoch from now()-next_attempt_at))) filter(where next_attempt_at<=now()),0)::text as oldest_due_seconds from media_object_orphans`);
    await client.query("rollback");
    return report;
  } finally {
    if (client) { await client.query("rollback").catch(() => {}); client.release(); }
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = {};
    for (let i=2;i<process.argv.length;i+=2) {
      if (!["--database-url","--ai-config-json","--window-minutes","--output"].includes(process.argv[i]) || !process.argv[i+1]) throw new Error("invalid_arguments");
      args[process.argv[i]] = process.argv[i+1];
    }
    const aiConfig = args["--ai-config-json"] ? JSON.parse(await readFile(args["--ai-config-json"], "utf8")) : {};
    const report = await reportRuntimeOperations({ databaseUrl: args["--database-url"], aiConfig,
      windowMinutes: args["--window-minutes"] ? Number(args["--window-minutes"]) : 60 });
    const output = `${JSON.stringify(report,null,2)}\n`;
    if (args["--output"]) await writeFile(args["--output"], output, { mode: 0o600 }); else process.stdout.write(output);
  } catch (error) { process.stderr.write(`Runtime operations snapshot failed: ${fixedError(error)}\n`); process.exitCode = 1; }
}
