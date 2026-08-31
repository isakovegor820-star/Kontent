\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

begin transaction isolation level repeatable read read only;

with relevant_ledger as (
  select name, checksum, applied_at
    from public.schema_migrations
   where name in (
     '20260916_session_token_hashes.sql',
     '20260918_site_analysis_project_scope.sql',
     '20260919_generation_monthly_lineage.sql',
     '20260920_session_token_expand_compat.sql'
   )
),
session_columns as (
  select column_name, data_type, is_nullable
    from information_schema.columns
   where table_schema = 'public'
     and table_name = 'sessions'
     and column_name in ('token', 'token_hash')
),
session_constraints as (
  select conname, pg_get_constraintdef(oid) as definition
    from pg_constraint
   where conrelid = to_regclass('public.sessions')
     and (conname ilike '%token%' or pg_get_constraintdef(oid) ilike '%token%')
),
session_boundary as (
  select applied_at
    from relevant_ledger
   where name = '20260916_session_token_hashes.sql'
),
session_rows as (
  select count(*)::bigint as total_rows,
         count(*) filter (where expires_at > clock_timestamp())::bigint as active_rows,
         count(*) filter (
           where nullif(to_jsonb(s)->>'token', '') is not null
             and (to_jsonb(s)->>'token') !~ '^[a-f0-9]{64}$'
         )::bigint as non_hash_token_rows,
         count(*) filter (
           where nullif(to_jsonb(s)->>'token_hash', '') is not null
             and (to_jsonb(s)->>'token_hash') !~ '^[a-f0-9]{64}$'
         )::bigint as non_hash_token_hash_rows,
         count(*) filter (
           where nullif(to_jsonb(s)->>'token', '') is not null
             and nullif(to_jsonb(s)->>'token_hash', '') is not null
             and (to_jsonb(s)->>'token') <> (to_jsonb(s)->>'token_hash')
         )::bigint as divergent_dual_rows,
         count(*) filter (
           where created_at <= (select applied_at from session_boundary)
             and expires_at > (select applied_at from session_boundary)
         )::bigint as non_invalidated_pre_migration_rows
    from public.sessions as s
),
database_capacity as (
  select current_setting('max_connections')::integer as max_connections,
         current_setting('superuser_reserved_connections')::integer as superuser_reserved_connections,
         (select count(*)::integer from pg_stat_activity) as observed_connections
)
select jsonb_build_object(
  'transactionReadOnly', current_setting('transaction_read_only'),
  'ledger', coalesce(
    (select jsonb_agg(to_jsonb(entry) order by entry.name) from relevant_ledger as entry),
    '[]'::jsonb
  ),
  'sessionColumns', coalesce(
    (select jsonb_agg(to_jsonb(entry) order by entry.column_name) from session_columns as entry),
    '[]'::jsonb
  ),
  'sessionConstraints', coalesce(
    (select jsonb_agg(to_jsonb(entry) order by entry.conname) from session_constraints as entry),
    '[]'::jsonb
  ),
  'sessionRows', (select to_jsonb(entry) from session_rows as entry),
  'databaseCapacity', (select to_jsonb(entry) from database_capacity as entry)
)::text;

commit;
