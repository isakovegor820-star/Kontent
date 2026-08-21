begin;

-- Release 1 rollout is explicit per project/channel and defaults off. A route may be
-- deployed before a cohort is enabled without exposing an unfinished read model.
create table if not exists channel_feature_flags (
  project_id bigint not null references projects (id) on delete cascade,
  channel_id bigint not null references channels (id) on delete cascade,
  feature_key varchar(80) not null,
  enabled boolean not null default false,
  enabled_by_user_id bigint references users (id) on delete set null,
  enabled_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (project_id, channel_id, feature_key),
  constraint channel_feature_flags_channel_project_fk
    foreign key (channel_id, project_id) references channels (id, project_id) on delete cascade,
  constraint channel_feature_flags_key_check
    check (feature_key in ('content_intelligence_release_1')),
  constraint channel_feature_flags_enabled_at_check
    check ((enabled = true and enabled_at is not null) or enabled = false)
);
create index if not exists channel_feature_flags_rollout_idx
  on channel_feature_flags (feature_key, enabled, project_id, channel_id);

create unique index if not exists growth_moves_id_project_channel_uniq
  on growth_moves (id, project_id, channel_id);

-- A snapshot is immutable evidence derived from an existing growth move. New source
-- data creates another revision; historical generation keeps the old snapshot.
create table if not exists opportunity_snapshots (
  id bigint generated always as identity primary key,
  project_id bigint not null references projects (id) on delete cascade,
  channel_id bigint not null references channels (id) on delete cascade,
  growth_move_id bigint not null references growth_moves (id) on delete restrict,
  revision integer not null default 1,
  fingerprint char(64) not null,
  topic_key varchar(200) not null,
  title varchar(200) not null,
  independent_angle text not null,
  confidence text not null,
  epistemic_state text not null,
  formula_version varchar(80) not null,
  evidence jsonb not null,
  observed_at timestamptz,
  expires_at timestamptz not null,
  source_context_draft_id bigint,
  created_at timestamptz not null default now(),
  constraint opportunity_snapshots_scope_uniq unique (id, project_id, channel_id),
  constraint opportunity_snapshots_move_revision_uniq unique (growth_move_id, revision),
  constraint opportunity_snapshots_channel_fingerprint_uniq unique (channel_id, fingerprint, revision),
  constraint opportunity_snapshots_channel_project_fk
    foreign key (channel_id, project_id) references channels (id, project_id) on delete cascade,
  constraint opportunity_snapshots_move_scope_fk
    foreign key (growth_move_id, project_id, channel_id)
    references growth_moves (id, project_id, channel_id) on delete restrict,
  constraint opportunity_snapshots_source_context_fk
    foreign key (source_context_draft_id, project_id)
    references drafts (id, project_id) on delete restrict,
  constraint opportunity_snapshots_revision_check check (revision > 0),
  constraint opportunity_snapshots_fingerprint_check check (fingerprint ~ '^[0-9a-f]{64}$'),
  constraint opportunity_snapshots_text_check check (
    length(btrim(topic_key)) between 1 and 200
    and length(btrim(title)) between 3 and 200
    and length(btrim(independent_angle)) between 3 and 2000
  ),
  constraint opportunity_snapshots_confidence_check check (confidence in ('low','medium','high')),
  constraint opportunity_snapshots_epistemic_check check (
    epistemic_state in ('observed','inferred','insufficient_data','stale')
  ),
  constraint opportunity_snapshots_formula_check check (length(btrim(formula_version)) between 1 and 80),
  constraint opportunity_snapshots_evidence_check check (jsonb_typeof(evidence) = 'object'),
  constraint opportunity_snapshots_ttl_check check (expires_at > created_at)
);
create index if not exists opportunity_snapshots_channel_fresh_idx
  on opportunity_snapshots (project_id, channel_id, expires_at desc, id desc);
create index if not exists opportunity_snapshots_source_context_idx
  on opportunity_snapshots (project_id, source_context_draft_id)
  where source_context_draft_id is not null;

-- Only user disposition is persisted for Today. Card content remains a projection over
-- opportunities, editorial work, publication truth and mature statistics.
create table if not exists today_item_states (
  project_id bigint not null references projects (id) on delete cascade,
  channel_id bigint not null references channels (id) on delete cascade,
  user_id bigint not null references users (id) on delete cascade,
  fingerprint char(64) not null,
  ranking_version varchar(80) not null,
  state text not null,
  snoozed_until timestamptz,
  state_version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (project_id, channel_id, user_id, fingerprint),
  constraint today_item_states_member_fk
    foreign key (project_id, user_id) references project_members (project_id, user_id) on delete cascade,
  constraint today_item_states_channel_project_fk
    foreign key (channel_id, project_id) references channels (id, project_id) on delete cascade,
  constraint today_item_states_fingerprint_check check (fingerprint ~ '^[0-9a-f]{64}$'),
  constraint today_item_states_ranking_check check (length(btrim(ranking_version)) between 1 and 80),
  constraint today_item_states_state_check check (
    state in ('active','done','dismissed','snoozed','expired','superseded')
  ),
  constraint today_item_states_snooze_check check (
    (state = 'snoozed' and snoozed_until is not null) or
    (state <> 'snoozed' and snoozed_until is null)
  ),
  constraint today_item_states_version_check check (state_version > 0)
);
create index if not exists today_item_states_user_active_idx
  on today_item_states (user_id, project_id, channel_id, state, updated_at desc);

commit;
