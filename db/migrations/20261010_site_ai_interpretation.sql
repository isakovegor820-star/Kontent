begin;

-- Гибрид «факты — скрипт, смысл — модель»: детерминированные профиль и отчёт остаются
-- источником истины; модель добавляет кэшируемую классификацию страниц/тем и
-- интерпретацию отчёта отдельным слоем.
alter table site_profiles add column if not exists ai_classification jsonb;
alter table site_profiles add column if not exists refined_at timestamptz;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'site_profiles_ai_classification_check') then
    alter table site_profiles add constraint site_profiles_ai_classification_check
      check (ai_classification is null or jsonb_typeof(ai_classification) = 'object');
  end if;
end $$;

alter table site_reports add column if not exists interpretation jsonb;
alter table site_reports add column if not exists interpretation_status text not null default 'pending';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'site_reports_interpretation_check') then
    alter table site_reports add constraint site_reports_interpretation_check
      check (interpretation is null or jsonb_typeof(interpretation) = 'object');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'site_reports_interpretation_status_check') then
    alter table site_reports add constraint site_reports_interpretation_status_check
      check (interpretation_status in ('pending', 'ready', 'skipped', 'failed'));
  end if;
end $$;
create index if not exists site_reports_interpretation_pending_idx
  on site_reports (interpretation_status, created_at) where interpretation_status = 'pending';

commit;
