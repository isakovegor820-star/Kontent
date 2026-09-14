begin;
-- Text availability and semantic indexing have independent lifecycles. Preserve rows
-- and existing chunk IDs (autopilot checkpoints reference them).
alter table knowledge_sources add column if not exists text_indexed_at timestamptz;
alter table knowledge_sources add column if not exists embedding_model text;
alter table knowledge_sources add column if not exists embedding_attempts integer not null default 0;
alter table knowledge_sources add column if not exists last_attempt_at timestamptz;
alter table knowledge_sources add column if not exists next_retry_at timestamptz;
alter table knowledge_sources add column if not exists embedding_error_code text;
alter table knowledge_chunks add column if not exists embedding_model text;
create index if not exists knowledge_sources_retry_idx on knowledge_sources (next_retry_at, last_attempt_at, id) where status <> 'error';
alter table discovered_sources add column if not exists content_embedding_model text;
commit;
