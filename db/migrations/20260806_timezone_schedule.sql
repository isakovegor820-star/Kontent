begin;

alter table drafts add column if not exists scheduled_timezone varchar(80);
alter table drafts add column if not exists scheduled_local_date date;
alter table drafts add column if not exists scheduled_local_time time;
alter table drafts add column if not exists scheduled_offset varchar(6);
alter table drafts add column if not exists scheduled_disambiguation text;

alter table publication_operations add column if not exists schedule_offset varchar(6);
alter table publication_operations add column if not exists schedule_disambiguation text;
alter table posts add column if not exists scheduled_timezone varchar(80);
alter table posts add column if not exists scheduled_offset varchar(6);
alter table posts add column if not exists scheduled_disambiguation text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conrelid = 'drafts'::regclass
      and conname = 'drafts_scheduled_disambiguation_check'
  ) then
    alter table drafts add constraint drafts_scheduled_disambiguation_check
      check (scheduled_disambiguation is null or scheduled_disambiguation in ('reject','earlier','later'));
  end if;
  if not exists (
    select 1 from pg_constraint where conrelid = 'publication_operations'::regclass
      and conname = 'publication_operations_schedule_disambiguation_check'
  ) then
    alter table publication_operations add constraint publication_operations_schedule_disambiguation_check
      check (schedule_disambiguation is null or schedule_disambiguation in ('reject','earlier','later'));
  end if;
  if not exists (
    select 1 from pg_constraint where conrelid = 'posts'::regclass
      and conname = 'posts_scheduled_disambiguation_check'
  ) then
    alter table posts add constraint posts_scheduled_disambiguation_check
      check (scheduled_disambiguation is null or scheduled_disambiguation in ('reject','earlier','later'));
  end if;
end $$;

commit;
