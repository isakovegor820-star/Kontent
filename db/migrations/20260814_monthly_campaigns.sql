begin;

-- Monthly campaigns are a project-scoped planning layer above the existing weekly
-- Autopilot. The existing weekly tables and workers remain the execution path.

-- A monthly item may point at one weekly Autopilot item. Give weekly plans the same
-- explicit tenant boundary as the rest of the collaboration model while preserving
-- legacy writers through the established channel-project trigger.
alter table autopilot_plan
  add column if not exists project_id bigint references projects (id) on delete restrict;
update autopilot_plan plan
   set project_id = coalesce(
     (select channel.project_id from channels channel where channel.id = plan.channel_id),
     (select project.id from projects project where project.personal_owner_user_id = plan.user_id)
   )
 where plan.project_id is null;
alter table autopilot_plan alter column project_id set not null;
create unique index if not exists autopilot_plan_id_project_uniq
  on autopilot_plan (id, project_id);
create index if not exists autopilot_plan_project_created_idx
  on autopilot_plan (project_id, created_at desc, id desc);

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'autopilot_plan_assign_project_before_insert') then
    create trigger autopilot_plan_assign_project_before_insert
      before insert on autopilot_plan for each row
      execute function aurora_assign_channel_project();
  end if;
end
$$;

-- Analytics snapshots inherit their project from the published post. The composite
-- keys below prevent a campaign item from pointing at another project's snapshot.
alter table post_stats
  add column if not exists project_id bigint references projects (id) on delete restrict;
update post_stats snapshot
   set project_id = post.project_id
  from posts post
 where snapshot.project_id is null
   and post.id = snapshot.post_id;
alter table post_stats alter column project_id set not null;
create unique index if not exists drafts_id_project_uniq on drafts (id, project_id);
create unique index if not exists post_stats_id_project_uniq on post_stats (id, project_id);
create unique index if not exists post_stats_id_post_project_uniq
  on post_stats (id, post_id, project_id);
create index if not exists post_stats_project_date_idx
  on post_stats (project_id, snapshot_date desc, id desc);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'post_stats_post_project_fk') then
    alter table post_stats add constraint post_stats_post_project_fk
      foreign key (post_id, project_id) references posts (id, project_id) on delete cascade;
  end if;
end
$$;

create or replace function aurora_assign_post_stats_project()
returns trigger
language plpgsql
as $$
begin
  if new.project_id is null then
    select post.project_id into new.project_id from posts post where post.id = new.post_id;
  end if;
  if new.project_id is null then
    raise exception 'project_context_missing' using errcode = '23514';
  end if;
  return new;
end
$$;

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'post_stats_assign_project_before_insert') then
    create trigger post_stats_assign_project_before_insert
      before insert on post_stats for each row
      execute function aurora_assign_post_stats_project();
  end if;
end
$$;

create table if not exists monthly_campaigns (
  id                         bigint generated always as identity primary key,
  project_id                 bigint not null references projects (id) on delete cascade,
  created_by_user_id         bigint not null references users (id) on delete restrict,
  updated_by_user_id         bigint not null references users (id) on delete restrict,
  goal                       text not null,
  starts_on                  date not null,
  ends_on                    date not null,
  timezone                   varchar(80) not null,
  rubrics                    text[] not null,
  practice_mix               jsonb not null,
  audience                   text not null,
  funnel_stages              text[] not null,
  posts_per_week             smallint not null,
  important_dates            jsonb not null default '[]'::jsonb,
  ctas                       text[] not null default '{}',
  metrics                    text[] not null default '{}',
  profile_version            bigint not null,
  content_brief_version      bigint not null,
  profile_hash               char(64) not null,
  brief_hash                 char(64) not null,
  request_key                varchar(128) not null,
  request_hash               char(64) not null,
  version                    bigint not null default 1,
  is_archived                boolean not null default false,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),
  constraint monthly_campaigns_goal_check check (length(btrim(goal)) between 1 and 500),
  constraint monthly_campaigns_period_check check ((ends_on - starts_on + 1) between 28 and 31),
  constraint monthly_campaigns_timezone_check check (length(btrim(timezone)) between 1 and 80),
  constraint monthly_campaigns_rubrics_check check (cardinality(rubrics) between 3 and 6),
  constraint monthly_campaigns_practice_mix_check check (jsonb_typeof(practice_mix) = 'array'),
  constraint monthly_campaigns_audience_check check (length(btrim(audience)) between 1 and 500),
  constraint monthly_campaigns_funnel_stages_check check (
    cardinality(funnel_stages) between 1 and 3
    and funnel_stages <@ array['awareness','consideration','consultation']::text[]
  ),
  constraint monthly_campaigns_frequency_check check (posts_per_week between 1 and 14),
  constraint monthly_campaigns_important_dates_check check (jsonb_typeof(important_dates) = 'array'),
  constraint monthly_campaigns_profile_version_check check (profile_version > 0),
  constraint monthly_campaigns_content_brief_version_check check (content_brief_version > 0),
  constraint monthly_campaigns_profile_hash_check check (profile_hash ~ '^[0-9a-f]{64}$'),
  constraint monthly_campaigns_brief_hash_check check (brief_hash ~ '^[0-9a-f]{64}$'),
  constraint monthly_campaigns_request_key_check check (length(btrim(request_key)) between 8 and 128),
  constraint monthly_campaigns_request_hash_check check (request_hash ~ '^[0-9a-f]{64}$'),
  constraint monthly_campaigns_version_check check (version > 0),
  unique (project_id, request_key),
  unique (id, project_id)
);
create index if not exists monthly_campaigns_project_period_idx
  on monthly_campaigns (project_id, starts_on desc, ends_on desc, id desc)
  where is_archived = false;

-- Each plan is an immutable-numbered revision of a campaign brief. Plan.version is
-- the optimistic-concurrency counter for status, reorder and regeneration markers.
create table if not exists monthly_campaign_plans (
  id                            bigint generated always as identity primary key,
  project_id                    bigint not null references projects (id) on delete cascade,
  campaign_id                   bigint not null references monthly_campaigns (id) on delete cascade,
  revision                      bigint not null,
  status                        text not null default 'draft',
  source_campaign_version       bigint not null,
  source_brief_hash             char(64) not null,
  source_profile_hash           char(64) not null,
  source_profile_version        bigint not null,
  source_content_brief_version  bigint not null,
  request_key                   varchar(128) not null,
  request_hash                  char(64) not null,
  version                       bigint not null default 1,
  created_by_user_id            bigint not null references users (id) on delete restrict,
  submitted_by_user_id          bigint references users (id) on delete set null,
  approved_by_user_id           bigint references users (id) on delete set null,
  submitted_at                  timestamptz,
  approved_at                   timestamptz,
  created_at                    timestamptz not null default now(),
  updated_at                    timestamptz not null default now(),
  constraint monthly_campaign_plans_status_check check (status in ('draft','in_review','approved')),
  constraint monthly_campaign_plans_revision_check check (revision > 0),
  constraint monthly_campaign_plans_source_campaign_version_check check (source_campaign_version > 0),
  constraint monthly_campaign_plans_source_brief_hash_check check (source_brief_hash ~ '^[0-9a-f]{64}$'),
  constraint monthly_campaign_plans_source_profile_hash_check check (source_profile_hash ~ '^[0-9a-f]{64}$'),
  constraint monthly_campaign_plans_source_profile_version_check check (source_profile_version > 0),
  constraint monthly_campaign_plans_source_content_brief_version_check check (source_content_brief_version > 0),
  constraint monthly_campaign_plans_request_key_check check (length(btrim(request_key)) between 8 and 128),
  constraint monthly_campaign_plans_request_hash_check check (request_hash ~ '^[0-9a-f]{64}$'),
  constraint monthly_campaign_plans_version_check check (version > 0),
  constraint monthly_campaign_plans_review_check check (
    (status = 'draft' and submitted_by_user_id is null and submitted_at is null
      and approved_by_user_id is null and approved_at is null)
    or (status = 'in_review' and submitted_by_user_id is not null and submitted_at is not null
      and approved_by_user_id is null and approved_at is null)
    or (status = 'approved' and submitted_by_user_id is not null and submitted_at is not null
      and approved_by_user_id is not null and approved_at is not null)
  ),
  constraint monthly_campaign_plans_campaign_project_fk foreign key (campaign_id, project_id)
    references monthly_campaigns (id, project_id) on delete cascade,
  unique (campaign_id, revision),
  unique (campaign_id, request_key),
  unique (id, campaign_id, project_id),
  unique (id, project_id)
);
create index if not exists monthly_campaign_plans_campaign_revision_idx
  on monthly_campaign_plans (project_id, campaign_id, revision desc, id desc);
create index if not exists monthly_campaign_plans_review_idx
  on monthly_campaign_plans (project_id, status, updated_at desc, id desc);

create table if not exists monthly_campaign_items (
  id                           bigint generated always as identity primary key,
  project_id                   bigint not null references projects (id) on delete cascade,
  plan_id                      bigint not null references monthly_campaign_plans (id) on delete cascade,
  item_key                     varchar(128) not null,
  scheduled_for                date not null,
  position                     integer not null,
  title                        varchar(240) not null,
  rubric                       varchar(120) not null,
  practice                     varchar(160) not null,
  funnel_stage                 text not null,
  state                        text not null default 'topic',
  approval_status              text not null default 'draft',
  content_version              bigint not null default 1,
  approved_content_version     bigint,
  source_item_id               bigint,
  weekly_autopilot_plan_id     bigint,
  weekly_autopilot_item_index  integer,
  draft_id                     bigint,
  post_id                      bigint,
  latest_post_stats_id         bigint,
  regeneration_version         bigint not null default 0,
  regeneration_status          text not null default 'idle',
  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now(),
  constraint monthly_campaign_items_key_check check (length(btrim(item_key)) between 1 and 128),
  constraint monthly_campaign_items_position_check check (position between 0 and 30),
  constraint monthly_campaign_items_title_check check (length(btrim(title)) between 1 and 240),
  constraint monthly_campaign_items_rubric_check check (length(btrim(rubric)) between 1 and 120),
  constraint monthly_campaign_items_practice_check check (length(btrim(practice)) between 1 and 160),
  constraint monthly_campaign_items_funnel_stage_check
    check (funnel_stage in ('awareness','consideration','consultation')),
  constraint monthly_campaign_items_state_check check (state in ('topic','detailed')),
  constraint monthly_campaign_items_approval_status_check
    check (approval_status in ('draft','in_review','approved')),
  constraint monthly_campaign_items_content_version_check check (content_version > 0),
  constraint monthly_campaign_items_approved_version_check check (
    (approval_status = 'approved' and approved_content_version = content_version)
    or (approval_status <> 'approved' and approved_content_version is null)
  ),
  constraint monthly_campaign_items_weekly_link_check check (
    (weekly_autopilot_plan_id is null and weekly_autopilot_item_index is null)
    or (weekly_autopilot_plan_id is not null and weekly_autopilot_item_index is not null
      and weekly_autopilot_item_index >= 0)
  ),
  constraint monthly_campaign_items_analytics_link_check check (
    latest_post_stats_id is null or post_id is not null
  ),
  constraint monthly_campaign_items_regeneration_version_check check (regeneration_version >= 0),
  constraint monthly_campaign_items_regeneration_status_check
    check (regeneration_status in ('idle','pending','processing','failed')),
  constraint monthly_campaign_items_plan_project_fk foreign key (plan_id, project_id)
    references monthly_campaign_plans (id, project_id) on delete cascade,
  constraint monthly_campaign_items_source_project_fk foreign key (source_item_id, project_id)
    references monthly_campaign_items (id, project_id) on delete restrict,
  constraint monthly_campaign_items_weekly_project_fk foreign key (weekly_autopilot_plan_id, project_id)
    references autopilot_plan (id, project_id) on delete restrict,
  constraint monthly_campaign_items_draft_project_fk foreign key (draft_id, project_id)
    references drafts (id, project_id) on delete restrict,
  constraint monthly_campaign_items_post_project_fk foreign key (post_id, project_id)
    references posts (id, project_id) on delete restrict,
  constraint monthly_campaign_items_stats_post_project_fk foreign key (latest_post_stats_id, post_id, project_id)
    references post_stats (id, post_id, project_id) on delete restrict,
  unique (plan_id, item_key),
  constraint monthly_campaign_items_plan_date_uniq
    unique (plan_id, scheduled_for) deferrable initially immediate,
  constraint monthly_campaign_items_plan_position_uniq
    unique (plan_id, position) deferrable initially immediate,
  unique (id, project_id)
);
create index if not exists monthly_campaign_items_plan_order_idx
  on monthly_campaign_items (project_id, plan_id, scheduled_for, position, id);
create index if not exists monthly_campaign_items_lineage_idx
  on monthly_campaign_items (project_id, weekly_autopilot_plan_id, draft_id, post_id);

-- Regeneration is an honest durable request. Until a worker consumes this outbox,
-- the existing approved text remains intact and only target markers become pending.
create table if not exists monthly_campaign_regeneration_operations (
  id                       bigint generated always as identity primary key,
  project_id               bigint not null references projects (id) on delete cascade,
  campaign_id              bigint not null references monthly_campaigns (id) on delete cascade,
  plan_id                  bigint not null references monthly_campaign_plans (id) on delete cascade,
  requested_by_user_id     bigint not null references users (id) on delete restrict,
  scope                    text not null,
  week_starts_on           date,
  request_key              varchar(128) not null,
  request_hash             char(64) not null,
  base_plan_version        bigint not null,
  base_brief_hash          char(64) not null,
  base_profile_hash        char(64) not null,
  status                   text not null default 'pending',
  result_plan_id           bigint,
  error_code               varchar(100),
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  completed_at             timestamptz,
  constraint monthly_campaign_regeneration_scope_check check (scope in ('item','week')),
  constraint monthly_campaign_regeneration_week_check check (
    (scope = 'item' and week_starts_on is null)
    or (scope = 'week' and week_starts_on is not null)
  ),
  constraint monthly_campaign_regeneration_request_key_check
    check (length(btrim(request_key)) between 8 and 128),
  constraint monthly_campaign_regeneration_request_hash_check check (request_hash ~ '^[0-9a-f]{64}$'),
  constraint monthly_campaign_regeneration_plan_version_check check (base_plan_version > 0),
  constraint monthly_campaign_regeneration_brief_hash_check check (base_brief_hash ~ '^[0-9a-f]{64}$'),
  constraint monthly_campaign_regeneration_profile_hash_check check (base_profile_hash ~ '^[0-9a-f]{64}$'),
  constraint monthly_campaign_regeneration_status_check
    check (status in ('pending','processing','completed','stale','retryable_failed','failed','cancelled')),
  constraint monthly_campaign_regeneration_result_check check (
    (status = 'completed' and result_plan_id is not null and completed_at is not null)
    or (status <> 'completed' and result_plan_id is null)
  ),
  constraint monthly_campaign_regeneration_campaign_project_fk foreign key (campaign_id, project_id)
    references monthly_campaigns (id, project_id) on delete cascade,
  constraint monthly_campaign_regeneration_plan_project_fk foreign key (plan_id, campaign_id, project_id)
    references monthly_campaign_plans (id, campaign_id, project_id) on delete cascade,
  constraint monthly_campaign_regeneration_result_project_fk foreign key (result_plan_id, campaign_id, project_id)
    references monthly_campaign_plans (id, campaign_id, project_id) on delete restrict,
  unique (project_id, request_key),
  unique (id, project_id)
);
create index if not exists monthly_campaign_regeneration_plan_idx
  on monthly_campaign_regeneration_operations (project_id, plan_id, created_at desc, id desc);
create index if not exists monthly_campaign_regeneration_pending_idx
  on monthly_campaign_regeneration_operations (status, updated_at, id)
  where status in ('pending','retryable_failed');

create table if not exists monthly_campaign_regeneration_targets (
  operation_id        bigint not null references monthly_campaign_regeneration_operations (id) on delete cascade,
  project_id          bigint not null references projects (id) on delete cascade,
  item_id             bigint not null references monthly_campaign_items (id) on delete cascade,
  item_content_version bigint not null,
  created_at          timestamptz not null default now(),
  constraint monthly_campaign_regeneration_targets_version_check check (item_content_version > 0),
  constraint monthly_campaign_regeneration_targets_operation_project_fk foreign key (operation_id, project_id)
    references monthly_campaign_regeneration_operations (id, project_id) on delete cascade,
  constraint monthly_campaign_regeneration_targets_item_project_fk foreign key (item_id, project_id)
    references monthly_campaign_items (id, project_id) on delete cascade,
  primary key (operation_id, item_id)
);

create table if not exists monthly_campaign_regeneration_outbox (
  id               bigint generated always as identity primary key,
  operation_id     bigint not null unique references monthly_campaign_regeneration_operations (id) on delete cascade,
  project_id       bigint not null references projects (id) on delete cascade,
  status           text not null default 'pending',
  attempts         integer not null default 0,
  next_attempt_at  timestamptz not null default now(),
  lease_token      varchar(128),
  lease_expires_at timestamptz,
  last_error_code  varchar(100),
  enqueued_at      timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint monthly_campaign_regeneration_outbox_status_check
    check (status in ('pending','dispatching','enqueued','retryable_failed','failed','cancelled')),
  constraint monthly_campaign_regeneration_outbox_attempts_check check (attempts >= 0),
  constraint monthly_campaign_regeneration_outbox_lease_check check (
    (lease_token is null and lease_expires_at is null)
    or (lease_token is not null and lease_expires_at is not null)
  ),
  constraint monthly_campaign_regeneration_outbox_operation_project_fk foreign key (operation_id, project_id)
    references monthly_campaign_regeneration_operations (id, project_id) on delete cascade
);
create index if not exists monthly_campaign_regeneration_outbox_due_idx
  on monthly_campaign_regeneration_outbox (next_attempt_at, id)
  where status in ('pending','retryable_failed');

commit;
