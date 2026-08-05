begin;

-- Подробная анкета автора живёт в поканальном брифе и развивается без новой
-- колонки на каждый вопрос. Нормализатор принимает только известные q1–q26.
alter table content_brief
  add column if not exists profile_answers jsonb not null default '{}'::jsonb;

commit;
