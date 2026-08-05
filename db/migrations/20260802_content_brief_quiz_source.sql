begin;

-- Онбординг сохраняет source='quiz'. Старое ограничение принимало только ai/manual,
-- поэтому корректный бриф отклонялся PostgreSQL и мастер не переходил к шагу профиля.
alter table content_brief drop constraint if exists content_brief_source_check;
alter table content_brief
  add constraint content_brief_source_check
  check (source in ('ai', 'manual', 'quiz'));

commit;
