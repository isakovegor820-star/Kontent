begin;

alter table competitors
  add column if not exists collection_requested_by_user_id bigint references users(id) on delete set null;

comment on column competitors.collection_requested_by_user_id is
  'Actual actor who explicitly enabled or refreshed this collection. Creator identity is unchanged. Legacy null rows require an authorized explicit refresh/resume; never infer an actor or backfill from the creator.';

commit;
