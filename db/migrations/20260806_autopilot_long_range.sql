-- Long-range Autopilot generation. Settings hold the user's defaults, while every
-- plan snapshots them so changing the controls cannot mutate an in-flight build.

begin;

create table if not exists autopilot_settings (
  user_id          bigint not null references users (id) on delete cascade,
  channel_id       bigint not null references channels (id) on delete cascade,
  enabled          boolean not null default false,
  mode             text not null default 'confirm' check (mode in ('confirm', 'full')),
  post_frequency   int not null default 5,
  approvals_streak int not null default 0,
  updated_at       timestamptz not null default now(),
  primary key (user_id, channel_id)
);

alter table autopilot_settings
  add column if not exists generation_engine text not null default 'navy-deepseek-pro';
alter table autopilot_settings
  add column if not exists planning_months smallint not null default 1;

do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conrelid = 'autopilot_settings'::regclass
       and conname = 'autopilot_settings_generation_engine_check'
  ) then
    alter table autopilot_settings
      add constraint autopilot_settings_generation_engine_check
        check (generation_engine in (
          'navy-deepseek-pro',
          'navy-deepseek-flash',
          'navy-gpt-5-4',
          'navy-qwen-3-6',
          'navy-minimax-m3'
        ));
  end if;
  if not exists (
    select 1
      from pg_constraint
     where conrelid = 'autopilot_settings'::regclass
       and conname = 'autopilot_settings_planning_months_check'
  ) then
    alter table autopilot_settings
      add constraint autopilot_settings_planning_months_check
        check (planning_months in (1, 2, 3));
  end if;
end
$$;

alter table autopilot_plan
  add column if not exists generation_engine text not null default 'navy-deepseek-pro';
alter table autopilot_plan
  add column if not exists planning_months smallint not null default 1;

do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conrelid = 'autopilot_plan'::regclass
       and conname = 'autopilot_plan_generation_engine_check'
  ) then
    alter table autopilot_plan
      add constraint autopilot_plan_generation_engine_check
        check (generation_engine in (
          'navy-deepseek-pro',
          'navy-deepseek-flash',
          'navy-gpt-5-4',
          'navy-qwen-3-6',
          'navy-minimax-m3'
        ));
  end if;
  if not exists (
    select 1
      from pg_constraint
     where conrelid = 'autopilot_plan'::regclass
       and conname = 'autopilot_plan_planning_months_check'
  ) then
    alter table autopilot_plan
      add constraint autopilot_plan_planning_months_check
        check (planning_months in (1, 2, 3));
  end if;
end
$$;

commit;
