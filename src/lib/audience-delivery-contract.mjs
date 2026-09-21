export const AUDIENCE_DELIVERY_LEASE_SECONDS = 120;

export const AUDIENCE_DELIVERY_ERROR_CODES = Object.freeze({
  unknown: "delivery_unknown",
  rejected: "telegram_rejected",
});

export const AUDIENCE_STALE_PROJECT_DELIVERIES_SQL = `
  with recovered as (
    update bot_client_inquiries
       set status = 'failed', delivery_error_code = 'delivery_unknown',
           resolved_by_user_id = null, resolved_at = null,
           version = version + 1, updated_at = now()
     where project_id = $1 and status = 'approved'
       and (provider_started_at is null
         or provider_started_at <= now() - ($2::text || ' seconds')::interval)
     returning id, project_id, version
  )
  insert into audit_events (
    project_id, actor_user_id, action, entity_type, entity_id,
    after_version, safe_data, idempotency_key
  )
  select recovered.project_id, null, 'audience.reply.delivery_failed',
         'bot_client_inquiry', recovered.id::text, recovered.version,
         jsonb_build_object('provider', 'telegram', 'code', 'delivery_unknown',
                            'surface', 'lease_recovery'),
         'audit:audience-recovery:' || recovered.id::text || ':v' || recovered.version::text
    from recovered
  on conflict (project_id, idempotency_key) where idempotency_key is not null do nothing
  returning entity_id as id, after_version as version`;

export const AUDIENCE_STALE_ALL_DELIVERIES_SQL = `
  with stale as (
    select id
      from bot_client_inquiries
     where status = 'approved'
       and (provider_started_at is null
         or provider_started_at <= now() - ($1::text || ' seconds')::interval)
     order by provider_started_at nulls first, id
     limit $2
     for update skip locked
  ), recovered as (
    update bot_client_inquiries inquiry
       set status = 'failed', delivery_error_code = 'delivery_unknown',
           resolved_by_user_id = null, resolved_at = null,
           version = inquiry.version + 1, updated_at = now()
      from stale
     where inquiry.id = stale.id and inquiry.status = 'approved'
     returning inquiry.id, inquiry.project_id, inquiry.version
  )
  insert into audit_events (
    project_id, actor_user_id, action, entity_type, entity_id,
    after_version, safe_data, idempotency_key
  )
  select recovered.project_id, null, 'audience.reply.delivery_failed',
         'bot_client_inquiry', recovered.id::text, recovered.version,
         jsonb_build_object('provider', 'telegram', 'code', 'delivery_unknown',
                            'surface', 'worker_recovery'),
         'audit:audience-recovery:' || recovered.id::text || ':v' || recovered.version::text
    from recovered
  on conflict (project_id, idempotency_key) where idempotency_key is not null do nothing
  returning project_id, entity_id as id, after_version as version`;

export const AUDIENCE_STALE_DELIVERY_CAS_SQL = `
  with recovered as (
    update bot_client_inquiries
       set status = 'failed', delivery_error_code = 'delivery_unknown',
           resolved_by_user_id = null, resolved_at = null,
           version = version + 1, updated_at = now()
     where id = $1 and project_id = $2 and status = 'approved' and version = $3
     returning id, project_id, version
  )
  insert into audit_events (
    project_id, actor_user_id, action, entity_type, entity_id,
    after_version, safe_data, idempotency_key
  )
  select recovered.project_id, null, 'audience.reply.delivery_failed',
         'bot_client_inquiry', recovered.id::text, recovered.version,
         jsonb_build_object('provider', 'telegram', 'code', 'delivery_unknown',
                            'surface', 'lease_recovery'),
         'audit:audience-recovery:' || recovered.id::text || ':v' || recovered.version::text
    from recovered
  on conflict (project_id, idempotency_key) where idempotency_key is not null do nothing
  returning after_version as version`;

export const AUDIENCE_FAIL_DELIVERY_SQL = `
  with failed as (
    update bot_client_inquiries
       set status = 'failed', delivery_error_code = $4,
           resolved_by_user_id = null, resolved_at = null,
           version = version + 1, updated_at = now()
     where id = $1 and project_id = $2 and status = 'approved'
       and delivery_request_key = $3
     returning id, project_id, version
  )
  insert into audit_events (
    project_id, actor_user_id, action, entity_type, entity_id,
    after_version, safe_data, idempotency_key
  )
  select failed.project_id, $5, 'audience.reply.delivery_failed',
         'bot_client_inquiry', failed.id::text, failed.version,
         jsonb_build_object('provider', 'telegram', 'code', $4::text, 'surface', $6::text),
         left('audit:audience-failed:' || failed.id::text || ':' || $3::text, 180)
    from failed
  on conflict (project_id, idempotency_key) where idempotency_key is not null do nothing
  returning after_version as version`;

export const AUDIENCE_FINISH_DELIVERY_SQL = `
  with delivered as (
    update bot_client_inquiries
       set status = 'sent', sent_external_message_id = $4,
           delivery_error_code = null, resolved_by_user_id = $5,
           resolved_at = now(), version = version + 1, updated_at = now()
     where id = $1 and project_id = $2 and status = 'approved'
       and delivery_request_key = $3
     returning id, project_id, version
  )
  insert into audit_events (
    project_id, actor_user_id, action, entity_type, entity_id,
    after_version, safe_data, idempotency_key
  )
  select delivered.project_id, $5, 'audience.reply.sent',
         'bot_client_inquiry', delivered.id::text, delivered.version,
         jsonb_build_object('provider', 'telegram', 'surface', $6::text),
         left('audit:audience-reply:' || delivered.id::text || ':' || $3::text, 180)
    from delivered
  on conflict (project_id, idempotency_key) where idempotency_key is not null do nothing
  returning after_version as version`;

export function audienceDeliveryLeaseExpired(providerStartedAt, nowMs = Date.now()) {
  const startedAt = new Date(providerStartedAt).getTime();
  return !Number.isFinite(startedAt)
    || startedAt <= nowMs - AUDIENCE_DELIVERY_LEASE_SECONDS * 1_000;
}

/**
 * A positive Telegram acknowledgement is trustworthy only with a durable message id.
 * An explicit ok:false is a provider rejection; every malformed success is ambiguous.
 */
export function classifyAudienceTelegramResponse(response) {
  if (response?.ok === false) return { kind: "rejected" };
  if (response?.ok !== true) return { kind: "unknown" };
  const externalMessageId = Number(response?.result?.message_id);
  if (!Number.isSafeInteger(externalMessageId) || externalMessageId <= 0) {
    return { kind: "unknown" };
  }
  return { kind: "delivered", externalMessageId };
}
