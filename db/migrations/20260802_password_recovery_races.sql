begin;

alter table users add column if not exists credential_epoch bigint not null default 1;
alter table users add column if not exists password_reset_generation bigint not null default 0;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'users_credential_epoch_check') then
    alter table users add constraint users_credential_epoch_check check (credential_epoch > 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'users_password_reset_generation_check') then
    alter table users add constraint users_password_reset_generation_check check (password_reset_generation >= 0);
  end if;
end $$;

alter table sessions add column if not exists credential_epoch bigint;
update sessions s set credential_epoch = u.credential_epoch
  from users u where u.id = s.user_id and s.credential_epoch is null;
alter table sessions alter column credential_epoch set not null;
create index if not exists sessions_user_epoch_idx on sessions (user_id, credential_epoch);

alter table password_reset_tokens add column if not exists generation bigint;
update password_reset_tokens t set generation = greatest(1, u.password_reset_generation)
  from users u where u.id = t.user_id and t.generation is null;
alter table password_reset_tokens alter column generation set not null;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'password_reset_tokens_generation_check') then
    alter table password_reset_tokens add constraint password_reset_tokens_generation_check check (generation > 0);
  end if;
end $$;
create unique index if not exists password_reset_tokens_user_generation_uniq
  on password_reset_tokens (user_id, generation);

create table if not exists password_reset_outbox (
  id                bigint generated always as identity primary key,
  user_id           bigint not null references users (id) on delete cascade,
  token_id          bigint not null unique references password_reset_tokens (id) on delete cascade,
  generation        bigint not null,
  recipient         text not null,
  token_envelope    text not null,
  status            text not null default 'pending'
                    check (status in ('pending','sending','sent','failed','cancelled')),
  attempts          integer not null default 0 check (attempts >= 0),
  next_attempt_at   timestamptz not null default now(),
  lease_token       text,
  lease_expires_at  timestamptz,
  last_error_code   text,
  sent_at           timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists password_reset_outbox_due_idx
  on password_reset_outbox (next_attempt_at, id)
  where status in ('pending','failed');

commit;
