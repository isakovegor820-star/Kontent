\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

-- Read-only Autopilot incident probe. It never writes, never migrates and never
-- selects free-text drafts: only counts, statuses and short diagnostic codes leave
-- the database so the report can be pasted into an incident review.
begin transaction isolation level repeatable read read only;

with ledger_tail as (
  select name, applied_at
    from public.schema_migrations
   order by name desc
   limit 14
),
ledger_total as (
  select count(*)::bigint as applied_migrations from public.schema_migrations
),
settings_rows as (
  select s.project_id,
         s.channel_id,
         s.enabled,
         s.mode,
         s.post_frequency,
         s.planning_weeks,
         s.planning_months,
         s.approvals_streak,
         s.generation_engine,
         jsonb_array_length(coalesce(s.news_sources, '[]'::jsonb)) as news_source_count,
         s.quick_settings,
         s.updated_at
    from public.autopilot_settings as s
   order by s.updated_at desc
   limit 20
),
-- `worker_would_load` replays loadBriefW() exactly. A build whose brief fails it returns
-- `no_brief` as an ordinary value, so the BullMQ job completes, `removeOnComplete` deletes
-- it and the plan row stays `building` with nothing in any queue and no failure recorded.
-- Without this column that stall is invisible from both the queue and the plan table.
brief_rows as (
  select b.project_id,
         b.channel_id,
         b.user_id,
         b.ready,
         b.source,
         length(btrim(coalesce(b.niche, ''))) as niche_chars,
         length(btrim(coalesce(b.audience, ''))) as audience_chars,
         (
           b.ready is true
           and length(btrim(coalesce(b.niche, ''))) >= 3
           and length(btrim(coalesce(b.audience, ''))) >= 3
         ) as worker_would_load,
         coalesce(array_length(b.rubrics, 1), 0) as rubric_count,
         b.updated_at
    from public.content_brief as b
   order by b.updated_at desc
   limit 20
),
-- Every channel a `building` plan is waiting on, with whether its brief passes the gate.
building_plan_briefs as (
  select distinct p.channel_id,
         p.project_id,
         (
           select count(*) from public.autopilot_plan as q
            where q.channel_id = p.channel_id and q.project_id = p.project_id
              and q.status = 'building'
         ) as building_plans,
         exists (
           select 1 from public.content_brief as b
            where b.project_id = p.project_id and b.channel_id = p.channel_id
              and b.ready is true
              and length(btrim(coalesce(b.niche, ''))) >= 3
              and length(btrim(coalesce(b.audience, ''))) >= 3
         ) as brief_passes_worker_gate
    from public.autopilot_plan as p
   where p.status = 'building'
),
plan_status_counts as (
  select status, count(*)::bigint as plans
    from public.autopilot_plan
   group by status
),
plan_rows as (
  select p.id,
         p.status,
         p.week_start,
         p.created_at,
         p.build_activity_at,
         jsonb_array_length(coalesce(p.items, '[]'::jsonb)) as item_count,
         p.expected_post_count,
         p.planning_weeks,
         p.generation_engine,
         -- `rules` carries the machine diagnosis for failed builds. Truncate hard: the
         -- successful-build variant of the same column holds editorial prose.
         left(coalesce(p.rules, ''), 300) as rules_head,
         (to_jsonb(p) - 'items' - 'candidate_items' - 'rules') as meta
    from public.autopilot_plan as p
   order by p.created_at desc
   limit 12
),
stuck_building as (
  select count(*)::bigint as building_plans,
         min(created_at) as oldest_building_at,
         max(created_at) as newest_building_at
    from public.autopilot_plan
   where status = 'building'
),
ai_usage_today as (
  select count(*)::bigint as calls_today,
         count(*) filter (where kind = 'autopilot-plan')::bigint as autopilot_plan_calls_today
    from public.ai_usage
   where usage_date = current_date
),
ai_usage_recent as (
  select usage_date, kind, count(*)::bigint as calls
    from public.ai_usage
   where usage_date >= current_date - 7
   group by usage_date, kind
   order by usage_date desc, kind
),
channel_rows as (
  select count(*)::bigint as channels,
         count(*) filter (where coalesce(to_jsonb(c)->>'status', '') = 'active')::bigint as active_channels
    from public.channels as c
),
-- A plan the recovery scan cannot see is indistinguishable, from the UI, from a plan that
-- is still building. reconcileBuildingAutopilotPlans() inner-joins the channel, an active
-- privileged member and the settings row, so one failing predicate silently removes the
-- plan from every retry path forever. Evaluate each predicate separately per stuck plan.
recovery_visibility as (
  select p.id as plan_id,
         p.status,
         p.project_id,
         p.channel_id,
         p.repair_strategy,
         exists (
           select 1 from public.channels c
            where c.id = p.channel_id and c.project_id = p.project_id
              and c.network = 'tg' and c.is_active = true
         ) as channel_join_ok,
         exists (
           select 1 from public.project_members m
            where m.project_id = p.project_id and m.user_id = p.user_id
              and m.status = 'active' and m.role in ('owner','author','approver')
         ) as member_join_ok,
         exists (
           select 1 from public.autopilot_settings s
            where s.project_id = p.project_id and s.channel_id = p.channel_id
         ) as settings_join_ok,
         (p.build_report -> 'autoRecovery' ->> 'jobId') as auto_recovery_job_id
    from public.autopilot_plan as p
   where p.status in ('building', 'partial')
   order by p.id desc
   limit 20
)
select jsonb_pretty(jsonb_build_object(
  'transactionReadOnly', current_setting('transaction_read_only'),
  'databaseNow', clock_timestamp(),
  'appliedMigrations', (select applied_migrations from ledger_total),
  'ledgerTail', coalesce((select jsonb_agg(to_jsonb(e) order by e.name desc) from ledger_tail as e), '[]'::jsonb),
  'autopilotSettings', coalesce((select jsonb_agg(to_jsonb(e)) from settings_rows as e), '[]'::jsonb),
  'contentBriefs', coalesce((select jsonb_agg(to_jsonb(e)) from brief_rows as e), '[]'::jsonb),
  'buildingPlanBriefs', coalesce(
    (select jsonb_agg(to_jsonb(e) order by e.channel_id) from building_plan_briefs as e),
    '[]'::jsonb
  ),
  'planStatusCounts', coalesce((select jsonb_agg(to_jsonb(e) order by e.status) from plan_status_counts as e), '[]'::jsonb),
  'recentPlans', coalesce((select jsonb_agg(to_jsonb(e)) from plan_rows as e), '[]'::jsonb),
  'stuckBuilding', (select to_jsonb(e) from stuck_building as e),
  'aiUsageToday', (select to_jsonb(e) from ai_usage_today as e),
  'aiUsageRecent', coalesce((select jsonb_agg(to_jsonb(e)) from ai_usage_recent as e), '[]'::jsonb),
  'channels', (select to_jsonb(e) from channel_rows as e),
  'recoveryVisibility', coalesce(
    (select jsonb_agg(to_jsonb(e) order by e.plan_id desc) from recovery_visibility as e),
    '[]'::jsonb
  )
))::text;

commit;
