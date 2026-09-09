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
         jsonb_typeof(s.quick_settings) = 'object' as quick_settings_configured,
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
         -- Truncation does not make editorial prose safe for a public workflow log.
         -- Preserve only known machine codes in failure context and explicit metadata.
         case when p.status in ('partial', 'error') then case when p.rules in ('provider_error', 'ai_unavailable', 'ai_usage_limit', 'quality_gate_unsatisfied', 'content_variety_insufficient', 'no_sources_found', 'no_brief', 'no_channel', 'overall_timeout', 'first_token_timeout', 'provider_timeout', 'circuit_open', 'empty_generation', 'network_error', 'rate_limited', 'quota_exceeded', 'stream_truncated', 'stream_error', 'reasoning_without_content') then p.rules else null end else null end as rules_code,
         length(coalesce(p.rules, '')) > 0 as rules_present,
         jsonb_build_object(
           'project_id', p.project_id,
           'channel_id', p.channel_id,
           'terminal_outcome', p.terminal_outcome,
           'repair_strategy', p.repair_strategy
         ) as meta
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
  select usage_date,
         case when kind in ('autopilot-plan', 'post', 'rewrite', 'chat', 'generate', 'semantic', 'site-analysis') then kind else null end as kind,
         encode(sha256(convert_to(kind, 'UTF8')), 'hex') as kind_sha256,
         count(*)::bigint as calls
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
-- Replays what enqueueWeeklyAutopilotPlan() decides for each enabled channel. It logs a
-- line when it queues and when it fails, but nothing when it skips, so a skipped channel is
-- indistinguishable from the scheduler never running. `target_ok` is its eligibility join;
-- `current_status` is the newest plan that owns the channel; `coverage_days_ahead` is how far
-- that plan's items reach, and anything beyond 7 makes it skip as already covered.
weekly_decision as (
  select s.project_id,
         s.channel_id,
         s.user_id,
         s.enabled,
         s.generation_engine,
         exists (
           select 1 from public.channels c
             join public.project_members m
               on m.project_id = s.project_id and m.user_id = s.user_id
              and m.status = 'active' and m.role in ('owner','author','approver')
            where c.id = s.channel_id and c.project_id = s.project_id
              and c.network = 'tg' and c.is_active = true
         ) as target_ok,
         cur.id as current_plan_id,
         cur.status as current_status,
         cur.week_start as current_week_start,
         round(
           extract(epoch from (cur.max_scheduled - now())) / 86400.0, 1
         ) as coverage_days_ahead
    from public.autopilot_settings as s
    left join lateral (
      select p.id, p.status, p.week_start,
             (
               select max((item ->> 'scheduledAt')::timestamptz)
                 from jsonb_array_elements(coalesce(p.items, '[]'::jsonb)) as item
                where (item ->> 'scheduledAt') is not null
             ) as max_scheduled
        from public.autopilot_plan as p
       where p.project_id = s.project_id and p.channel_id = s.channel_id
         and p.status in ('building', 'partial', 'pending', 'approved', 'approving')
       order by p.created_at desc, p.id desc
       limit 1
    ) as cur on true
   where s.enabled = true
   order by s.project_id, s.channel_id
),
-- The quota reservation key is deterministic per plan (`worker:autopilot-plan:<proj>:<plan>`).
-- A `committed` row against a plan that is still `building` is the wedge: the build charged
-- quota, died before writing a result, and every later replay returns "already done" without
-- doing anything, so the plan never leaves `building` and never records a failure.
building_plan_quota as (
  select p.id as plan_id,
         p.channel_id,
         p.status,
         p.created_at,
         'worker:autopilot-plan:' || p.project_id || ':' || p.id as reservation_key,
         u.status as reservation_status,
         u.finalized_at
    from public.autopilot_plan as p
    left join public.ai_usage as u
      on u.user_id = p.user_id
     and u.reservation_key = 'worker:autopilot-plan:' || p.project_id || ':' || p.id
   where p.status = 'building'
   order by p.id desc
   limit 20
),
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
         encode(sha256(convert_to(p.build_report -> 'autoRecovery' ->> 'jobId', 'UTF8')), 'hex') as auto_recovery_job_id_sha256
    from public.autopilot_plan as p
   where p.status in ('building', 'partial')
   order by p.id desc
   limit 20
),
-- Why each post of the newest finished plan did or did not count as deliverable.
--
-- `build_report.causes` is empty whenever an item fails only through
-- `confirmation_required`, `reviewRequired` or `qualityBlocked`, because the cause histogram
-- counts blocker violations exclusively. A build that produced ten drafts and delivered four
-- therefore reports "4/10 (без разбора)" and offers the reader no reason and no next step.
-- JSON strings are untrusted even when they resemble codes. Export known enums,
-- booleans/counts or SHA256 fingerprints for correlation; never arbitrary text.
plan_item_verdicts as (
  select p.id as plan_id,
         p.channel_id,
         p.status,
         (item.ordinality - 1) as item_index,
         case when (item.value ->> 'buildState') in ('queued', 'building', 'ready', 'failed', 'waiting_provider', 'confirmation_required') then (item.value ->> 'buildState') else null end as build_state,
         (item.value ->> 'aiReady') = 'true' as ai_ready,
         length(coalesce(item.value ->> 'draft', '')) as draft_chars,
         (item.value -> 'quality' ->> 'passed') = 'true' as quality_passed,
         case when (item.value -> 'quality' ->> 'publicationDisposition') in ('ready', 'confirmation_required', 'blocked') then (item.value -> 'quality' ->> 'publicationDisposition') else null end as disposition,
         (item.value ->> 'qualityBlocked') = 'true' as quality_blocked,
         (item.value ->> 'reviewRequired') = 'true' as review_required,
         case when (item.value -> '_providerFailure' ->> 'code') in ('provider_error', 'ai_unavailable', 'ai_usage_limit', 'quality_gate_unsatisfied', 'content_variety_insufficient', 'no_sources_found', 'no_brief', 'no_channel', 'overall_timeout', 'first_token_timeout', 'provider_timeout', 'circuit_open', 'empty_generation', 'network_error', 'rate_limited', 'quota_exceeded', 'stream_truncated', 'stream_error', 'reasoning_without_content') then (item.value -> '_providerFailure' ->> 'code') else null end as provider_failure_code,
         case when (item.value -> '_providerFailure' ->> 'engine') in ('navy-deepseek-pro', 'navy-deepseek-flash', 'navy-gpt-5-4', 'navy-qwen-3-6', 'navy-minimax-m3', 'openai', 'deepseek', 'ollama') then (item.value -> '_providerFailure' ->> 'engine') else null end as provider_failure_engine,
         -- `isAutopilotHumanReviewItem` lets a post through to a human only when the semantic
         -- fact-check could not run at all, and it demands an exact shape to prove that. Any
         -- single mismatch here demotes an otherwise clean post to `failed`, which is why six
         -- posts that passed every editorial gate were dropped from the week. These are the
         -- fields it reads, in the order it reads them — verdict codes only, never claim text.
         case when (item.value ->> 'reviewState') in ('semantic_only_review', 'editorial_review', 'quality_review') then (item.value ->> 'reviewState') else null end as review_state,
         case when (item.value ->> 'reviewReason') in ('deterministic_format', 'rewrite', 'add_knowledge', 'human_review', 'provider_retry', 'settings_change') then (item.value ->> 'reviewReason') else null end as review_reason,
         jsonb_array_length(
           case when jsonb_typeof(item.value -> 'invented') = 'array'
                then item.value -> 'invented' else '[]'::jsonb end
         ) as invented_count,
         case when (item.value -> 'quality' -> 'metadata' -> 'provenance' ->> 'validator') in ('validatePostQuality') then (item.value -> 'quality' -> 'metadata' -> 'provenance' ->> 'validator') else null end as quality_validator,
         case when (item.value -> 'quality' -> 'metadata' -> 'provenance' ->> 'trigger') in ('direct', 'generation', 'rewrite', 'edit_recheck') then (item.value -> 'quality' -> 'metadata' -> 'provenance' ->> 'trigger') else null end as quality_trigger,
         case when (item.value -> 'quality' -> 'metadata' -> 'rules' ->> 'version') in ('1') then (item.value -> 'quality' -> 'metadata' -> 'rules' ->> 'version') else null end as quality_rules_version,
         jsonb_array_length(
           case when jsonb_typeof(item.value -> 'quality' -> 'blockers') = 'array'
                then item.value -> 'quality' -> 'blockers' else '[]'::jsonb end
         ) as quality_blocker_count,
         case when (item.value -> 'quality' -> 'semantic' ->> 'status') in ('passed', 'blocked', 'not_checked') then (item.value -> 'quality' -> 'semantic' ->> 'status') else null end as semantic_status,
         case when (item.value -> 'quality' -> 'semantic' ->> 'version') in ('1') then (item.value -> 'quality' -> 'semantic' ->> 'version') else null end as semantic_version,
         (item.value -> 'quality' -> 'semantic' ->> 'passed') = 'true' as semantic_passed,
         (item.value -> 'quality' -> 'semantic' ->> 'requiresReview') = 'true' as semantic_requires_review,
         encode(sha256(convert_to((item.value -> 'quality' -> 'semantic' -> 'provenance' ->> 'provider'), 'UTF8')), 'hex') as semantic_provider_sha256,
         case when (item.value -> 'quality' -> 'semantic' -> 'provenance' ->> 'validatorVersion') in ('semantic-publication-v1') then (item.value -> 'quality' -> 'semantic' -> 'provenance' ->> 'validatorVersion') else null end
           as semantic_validator_version,
         case when (item.value -> 'quality' -> 'semantic' -> 'provenance' ->> 'terminalVerdict') in ('passed', 'blocked', 'not_checked') then (item.value -> 'quality' -> 'semantic' -> 'provenance' ->> 'terminalVerdict') else null end
           as semantic_terminal_verdict,
         jsonb_array_length(
           case when jsonb_typeof(item.value -> 'quality' -> 'semantic' -> 'claimVerdicts') = 'array'
                then item.value -> 'quality' -> 'semantic' -> 'claimVerdicts' else '[]'::jsonb end
         ) as semantic_claim_count,
         (
           select string_agg(distinct
                    coalesce(case when v ->> 'verdict' in ('supported', 'unsupported', 'unknown', 'non_factual') then v ->> 'verdict' else null end, 'unknown') || '/sha256:' || coalesce(encode(sha256(convert_to(v ->> 'reasonCode', 'UTF8')), 'hex'), 'null'),
                    ', ')
             from jsonb_array_elements(
                    case when jsonb_typeof(item.value -> 'quality' -> 'semantic' -> 'claimVerdicts') = 'array'
                         then item.value -> 'quality' -> 'semantic' -> 'claimVerdicts'
                         else '[]'::jsonb end
                  ) as v
         ) as semantic_verdicts,
         (
           select string_agg(distinct case when v ->> 'code' in ('empty', 'too_short', 'too_long', 'hook', 'address', 'profanity', 'profanity_required', 'forbidden_phrase', 'forbidden_topic', 'dense_paragraph', 'structure', 'list', 'bold', 'emoji', 'hashtags', 'disclaimer', 'meta_labels', 'punctuation', 'truncated', 'no_sources', 'weak_sources', 'invented', 'unsupported_semantic_claim', 'semantic_review_required', 'insufficient_content', 'platform_limit', 'quality_threshold', 'duplicate') then v ->> 'code' else null end, ',')
             from jsonb_array_elements(
                    case when jsonb_typeof(item.value -> 'quality' -> 'violations') = 'array'
                         then item.value -> 'quality' -> 'violations' else '[]'::jsonb end
                  ) as v
            where (v ->> 'blocker') = 'true'
         ) as blocker_codes,
         (
           select string_agg(distinct case when v ->> 'code' in ('empty', 'too_short', 'too_long', 'hook', 'address', 'profanity', 'profanity_required', 'forbidden_phrase', 'forbidden_topic', 'dense_paragraph', 'structure', 'list', 'bold', 'emoji', 'hashtags', 'disclaimer', 'meta_labels', 'punctuation', 'truncated', 'no_sources', 'weak_sources', 'invented', 'unsupported_semantic_claim', 'semantic_review_required', 'insufficient_content', 'platform_limit', 'quality_threshold', 'duplicate') then v ->> 'code' else null end, ',')
             from jsonb_array_elements(
                    case when jsonb_typeof(item.value -> 'quality' -> 'violations') = 'array'
                         then item.value -> 'quality' -> 'violations' else '[]'::jsonb end
                  ) as v
            where (v ->> 'blocker') is distinct from 'true'
         ) as advisory_codes
    from public.autopilot_plan as p
    cross join lateral jsonb_array_elements(coalesce(p.items, '[]'::jsonb))
      with ordinality as item(value, ordinality)
   where p.id = (
     select id from public.autopilot_plan
      where status in ('partial', 'pending', 'error')
      order by created_at desc, id desc
      limit 1
   )
   order by item_index
),
media_recent as (
  select g.id, g.request_id, g.kind, g.model, g.status, g.error_code,
         g.created_at, g.updated_at, g.completed_at,
         g.output_asset_id is not null as has_asset,
         g.provider_job_id is not null as has_provider_job,
         u.status as reservation_status
    from public.media_generations g
    left join public.ai_usage u on u.id = g.ai_usage_reservation_id
   where g.created_at > now() - interval '48 hours'
   order by g.created_at desc limit 30
),
ai_attempts_recent as (
  select logical_operation_id, phase, attempt_index, provider, model, outcome,
         safe_error_code, input_tokens, output_tokens, latency_ms, fallback, created_at
    from public.ai_provider_attempts
   where created_at > now() - interval '24 hours'
   order by created_at desc limit 40
)
select jsonb_pretty(jsonb_build_object(
  'transactionReadOnly', current_setting('transaction_read_only'),
  'databaseNow', clock_timestamp(),
  'appliedMigrations', (select applied_migrations from ledger_total),
  'ledgerTail', coalesce((select jsonb_agg(to_jsonb(e) order by e.name desc) from ledger_tail as e), '[]'::jsonb),
  'autopilotSettings', coalesce((select jsonb_agg(to_jsonb(e)) from settings_rows as e), '[]'::jsonb),
  'contentBriefs', coalesce((select jsonb_agg(to_jsonb(e)) from brief_rows as e), '[]'::jsonb),
  'weeklyDecision', coalesce(
    (select jsonb_agg(to_jsonb(e) order by e.project_id, e.channel_id) from weekly_decision as e),
    '[]'::jsonb
  ),
  'buildingPlanQuota', coalesce(
    (select jsonb_agg(to_jsonb(e) order by e.plan_id desc) from building_plan_quota as e),
    '[]'::jsonb
  ),
  'buildingPlanBriefs', coalesce(
    (select jsonb_agg(to_jsonb(e) order by e.channel_id) from building_plan_briefs as e),
    '[]'::jsonb
  ),
  'planStatusCounts', coalesce((select jsonb_agg(to_jsonb(e) order by e.status) from plan_status_counts as e), '[]'::jsonb),
  'recentPlans', coalesce((select jsonb_agg(to_jsonb(e)) from plan_rows as e), '[]'::jsonb),
  'stuckBuilding', (select to_jsonb(e) from stuck_building as e),
  'aiUsageToday', (select to_jsonb(e) from ai_usage_today as e),
  'aiUsageRecent', coalesce((select jsonb_agg(to_jsonb(e)) from ai_usage_recent as e), '[]'::jsonb),
  'mediaRecent', coalesce((select jsonb_agg(to_jsonb(e)) from media_recent as e), '[]'::jsonb),
  'aiAttemptsRecent', coalesce((select jsonb_agg(to_jsonb(e)) from ai_attempts_recent as e), '[]'::jsonb),
  'channels', (select to_jsonb(e) from channel_rows as e),
  'recoveryVisibility', coalesce(
    (select jsonb_agg(to_jsonb(e) order by e.plan_id desc) from recovery_visibility as e),
    '[]'::jsonb
  ),
  'planItemVerdicts', coalesce(
    (select jsonb_agg(to_jsonb(e) order by e.item_index) from plan_item_verdicts as e),
    '[]'::jsonb
  )
))::text;

commit;
