begin;

-- Пользовательские действия над инфоповодом не меняют технический статус RSS-item.
-- Поэтому сохранение, скрытие и использование живут отдельно от pipeline.
create table if not exists legal_opportunity_states (
  user_id      bigint      not null references users (id) on delete cascade,
  rss_item_id  bigint      not null references rss_items (id) on delete cascade,
  state        text        not null check (state in ('saved', 'dismissed', 'used')),
  updated_at   timestamptz not null default now(),
  primary key (user_id, rss_item_id)
);

create index if not exists legal_opportunity_states_user_state_idx
  on legal_opportunity_states (user_id, state, updated_at desc);

commit;
