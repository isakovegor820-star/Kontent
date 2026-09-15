#!/usr/bin/env bash
# Disconnect one exactly identified Telegram channel in production.
#
# Every identity field is verified under a row lock before the mutation. The
# operation refuses to run while a publication is scheduled, retrying or being
# sent, and is idempotent through its channel_events request id.
set -Eeuo pipefail

TARGET_HANDLE="${AURORA_DISCONNECT_HANDLE:?AURORA_DISCONNECT_HANDLE is required}"
TARGET_OWNER_EMAIL="${AURORA_DISCONNECT_OWNER_EMAIL:?AURORA_DISCONNECT_OWNER_EMAIL is required}"
TARGET_REQUEST_ID="${AURORA_DISCONNECT_REQUEST_ID:?AURORA_DISCONNECT_REQUEST_ID is required}"
CURRENT_LINK="${AURORA_CURRENT_LINK:-/opt/aurora-current}"

[[ "$TARGET_HANDLE" =~ ^[A-Za-z0-9_]{5,32}$ ]] || { echo "invalid Telegram handle" >&2; exit 1; }
[[ "$TARGET_OWNER_EMAIL" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] || { echo "invalid owner email" >&2; exit 1; }
[[ "$TARGET_REQUEST_ID" =~ ^[A-Za-z0-9._:-]{12,160}$ ]] || { echo "invalid request id" >&2; exit 1; }

current_path="$(readlink -f "$CURRENT_LINK")"
[[ -n "$current_path" && -f "$current_path/.env.production" ]] || {
  echo "production environment unavailable" >&2
  exit 1
}

cd "$current_path"
set -a
# shellcheck disable=SC1091
. ./.env.production
set +a
test -n "${DATABASE_URL:-}"

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -P pager=off <<SQL
begin;
set local statement_timeout = '15s';
\o /dev/null
select set_config('aurora.operator.handle', lower('$TARGET_HANDLE'), true);
select set_config('aurora.operator.owner_email', lower('$TARGET_OWNER_EMAIL'), true);
select set_config('aurora.operator.request_id', '$TARGET_REQUEST_ID', true);
\o

do \$operation\$
declare
  target channels%rowtype;
  blocking_count integer;
  active_match_count integer;
begin
  select count(*) into active_match_count
    from channels channel
    join users owner on owner.id = channel.user_id
   where channel.network = 'tg'
     and channel.is_active
     and lower(trim(leading '@' from coalesce(channel.handle, ''))) = current_setting('aurora.operator.handle')
     and lower(owner.email) = current_setting('aurora.operator.owner_email');

  if active_match_count <> 1 then
    raise exception 'production_active_channel_match_count:%', active_match_count;
  end if;

  select channel.* into target
    from channels channel
    join users owner on owner.id = channel.user_id
   where channel.network = 'tg'
     and channel.is_active
     and lower(trim(leading '@' from coalesce(channel.handle, ''))) = current_setting('aurora.operator.handle')
     and lower(owner.email) = current_setting('aurora.operator.owner_email')
   for update of channel;

  if not found then
    raise exception 'production_channel_identity_mismatch';
  end if;

  select count(*) into blocking_count
    from posts
   where channel_id = target.id
     and status in ('scheduled', 'failed_retry', 'publishing');
  if blocking_count > 0 then
    raise exception 'scheduled_publications_require_resolution:%', blocking_count;
  end if;

  if target.status <> 'disconnected' or target.is_active then
    update channels
       set status = 'disconnected',
           is_active = false,
           vk_token = null,
           oauth_token_id = null,
           disconnected_at = now(),
           updated_at = now()
     where id = target.id;

    update autopilot_settings
       set enabled = false,
           updated_at = now()
     where channel_id = target.id;

    insert into channel_events
      (channel_id, actor_user_id, action, from_status, to_status, request_id)
    values
      (target.id, target.user_id, 'disconnected', target.status, 'disconnected', current_setting('aurora.operator.request_id'))
    on conflict (channel_id, request_id) where request_id is not null do nothing;
  end if;
end
\$operation\$;
commit;

select json_build_object(
  'handle', channel.handle,
  'status', channel.status,
  'active', channel.is_active,
  'disconnectedAt', channel.disconnected_at,
  'released', not exists (
    select 1 from channels active
     where active.network = 'tg'
       and active.tg_chat_id = channel.tg_chat_id
       and active.is_active
  )
) as production_channel_result
from channels channel
join users owner on owner.id = channel.user_id
where channel.network = 'tg'
  and lower(trim(leading '@' from coalesce(channel.handle, ''))) = lower('$TARGET_HANDLE')
  and lower(owner.email) = lower('$TARGET_OWNER_EMAIL')
order by channel.updated_at desc, channel.id desc
limit 1;
SQL
