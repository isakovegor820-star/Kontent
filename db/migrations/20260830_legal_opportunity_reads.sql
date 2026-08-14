begin;

-- Прочтение инфоповода — персональное состояние внутри выбранного проекта.
-- Оно не меняет pipeline RSS и не смешивается с сохранением/скрытием/использованием.
create table if not exists legal_opportunity_reads (
  user_id      bigint      not null references users (id) on delete cascade,
  project_id   bigint      not null references projects (id) on delete cascade,
  rss_item_id  bigint      not null references rss_items (id) on delete cascade,
  read_at      timestamptz not null default now(),
  primary key (user_id, project_id, rss_item_id)
);

create index if not exists legal_opportunity_reads_scope_idx
  on legal_opportunity_reads (user_id, project_id, read_at desc);

commit;
