begin;

-- Existing rows contain live browser bearer tokens. Hashing them and expiring the rows
-- removes plaintext credentials from the primary database and deliberately signs every
-- browser out once. New application writes persist only the SHA-256 verifier.
create extension if not exists pgcrypto;

do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'sessions' and column_name = 'token'
  ) and not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'sessions' and column_name = 'token_hash'
  ) then
    alter table sessions rename column token to token_hash;
  end if;
end $$;

update sessions
   set token_hash = encode(digest(token_hash, 'sha256'), 'hex'),
       expires_at = least(expires_at, now());

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'sessions_token_hash_check'
  ) then
    alter table sessions
      add constraint sessions_token_hash_check check (token_hash ~ '^[a-f0-9]{64}$');
  end if;
end $$;

commit;
