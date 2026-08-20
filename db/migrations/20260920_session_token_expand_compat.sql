begin;

create extension if not exists pgcrypto;

-- Expand-only compatibility boundary. Historical installations may have either the
-- original hashed `token` column or the renamed `token_hash` column. Keep both during
-- rollout so the previous and current releases remain usable against the same schema.
alter table sessions add column if not exists token text;
alter table sessions add column if not exists token_hash text;

do $$
begin
  if exists (
    select 1 from sessions
     where token is not null and token_hash is not null and token <> token_hash
  ) then
    raise exception 'sessions token columns disagree; refusing automatic reconciliation';
  end if;
end
$$;

update sessions
   set token_hash = coalesce(token_hash, token),
       token = coalesce(token, token_hash),
       expires_at = least(expires_at, now());

do $$
declare
  hash_constraint_definition text;
begin
  select pg_get_constraintdef(oid) into hash_constraint_definition
    from pg_constraint
   where conrelid = 'sessions'::regclass and conname = 'sessions_token_hash_check';
  if hash_constraint_definition is not null
     and hash_constraint_definition ~ '\(token ~' then
    alter table sessions rename constraint sessions_token_hash_check
      to sessions_token_legacy_hash_check;
  end if;
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'sessions'::regclass and conname = 'sessions_token_hash_check'
  ) then
    alter table sessions add constraint sessions_token_hash_check
      check (token_hash ~ '^[a-f0-9]{64}$');
  end if;
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'sessions'::regclass and conname = 'sessions_token_legacy_hash_check'
  ) then
    alter table sessions add constraint sessions_token_legacy_hash_check
      check (token ~ '^[a-f0-9]{64}$');
  end if;
  if exists (select 1 from sessions where token is null or token_hash is null) then
    raise exception 'sessions token reconciliation left NULL values';
  end if;
end
$$;

alter table sessions alter column token set not null;
alter table sessions alter column token_hash set not null;

create unique index if not exists sessions_token_hash_compat_uniq on sessions (token_hash);
create unique index if not exists sessions_token_legacy_compat_uniq on sessions (token);

create or replace function aurora_sync_session_token_columns()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.token is not null and new.token_hash is not null and new.token <> new.token_hash then
      raise exception 'sessions token columns disagree';
    end if;
    new.token_hash := coalesce(new.token_hash, new.token);
    new.token := coalesce(new.token, new.token_hash);
  else
    if new.token is distinct from old.token and new.token_hash is distinct from old.token_hash
       and new.token is distinct from new.token_hash then
      raise exception 'sessions token columns disagree';
    elsif new.token_hash is distinct from old.token_hash then
      new.token := new.token_hash;
    elsif new.token is distinct from old.token then
      new.token_hash := new.token;
    end if;
  end if;
  if new.token is null or new.token_hash is null or new.token <> new.token_hash then
    raise exception 'sessions token columns incomplete';
  end if;
  return new;
end
$$;

drop trigger if exists sessions_sync_token_columns_before_write on sessions;
create trigger sessions_sync_token_columns_before_write
  before insert or update of token, token_hash on sessions
  for each row execute function aurora_sync_session_token_columns();

commit;
