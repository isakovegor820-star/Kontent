-- Legacy and test rows could claim to be active Telegram destinations without a chat id.
-- Quarantine them without deleting the connection, then prevent the invalid state recurring.
begin;

-- Some supported legacy fixtures predate the dedicated Telegram chat column.
alter table channels add column if not exists tg_chat_id bigint;

update channels
   set status = 'needs_reconnect',
       is_active = false,
       last_auth_error_code = 'telegram_chat_id_missing',
       last_auth_error_at = now(),
       updated_at = now()
 where network = 'tg'
   and status = 'active'
   and tg_chat_id is null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'channels_active_telegram_chat_check'
  ) then
    alter table channels
      add constraint channels_active_telegram_chat_check
      check (network <> 'tg' or status <> 'active' or (is_active = true and tg_chat_id is not null));
  end if;
end $$;

commit;
