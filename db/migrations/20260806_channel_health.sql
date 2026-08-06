begin;

alter table channels add column if not exists status text;
alter table channels add column if not exists last_auth_error_code text;
alter table channels add column if not exists last_auth_error_at timestamptz;
alter table channels add column if not exists disconnected_at timestamptz;
alter table channels add column if not exists updated_at timestamptz not null default now();

update channels
   set status = case when is_active then 'active' else 'disconnected' end
 where status is null;
alter table channels alter column status set default 'active';
alter table channels alter column status set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'channels'::regclass and conname = 'channels_status_check'
  ) then
    alter table channels add constraint channels_status_check
      check (status in ('active','needs_reconnect','permission_lost','revoked','disconnected'));
  end if;
end $$;

create table if not exists channel_events (
  id               bigint generated always as identity primary key,
  channel_id       bigint not null references channels (id) on delete cascade,
  actor_user_id    bigint references users (id) on delete set null,
  action           text not null,
  from_status      text,
  to_status        text not null,
  safe_error_code  text,
  request_id       text,
  created_at       timestamptz not null default now()
);
create index if not exists channel_events_channel_idx
  on channel_events (channel_id, created_at desc);
create unique index if not exists channel_events_request_uniq
  on channel_events (channel_id, request_id) where request_id is not null;

commit;
