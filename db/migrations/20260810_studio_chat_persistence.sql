begin;

-- История Студии должна переживать обновление страницы, закрытие вкладки и перезапуск
-- локального приложения. Клиентский storage остаётся только аварийной копией.
create table if not exists studio_chat_sessions (
  user_id     bigint primary key references users (id) on delete cascade,
  payload     jsonb       not null,
  revision    bigint      not null default 1,
  updated_at  timestamptz not null default now(),
  constraint studio_chat_sessions_payload_check
    check (jsonb_typeof(payload) = 'object'),
  constraint studio_chat_sessions_revision_check
    check (revision > 0)
);

commit;
