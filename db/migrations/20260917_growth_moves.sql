begin;

-- Weekly growth desk: at most a few persisted moves per channel and week.
-- Diagnosis is computed from existing stats, competitors, site analysis and
-- audience questions. Rows keep the week's set stable and remember done/skipped.

create table if not exists growth_moves (
  id           bigint generated always as identity primary key,
  project_id   bigint not null references projects (id) on delete cascade,
  channel_id   bigint not null references channels (id) on delete cascade,
  week_start   date not null,
  kind         text not null,
  status       text not null default 'open',
  confidence   text not null,
  title        varchar(200) not null,
  reason       text not null,
  prompt       text not null,
  action_href  text not null,
  source_kind  text,
  source_id    text,
  source_label text,
  fingerprint  char(64) not null,
  missing_slots integer,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint growth_moves_kind_check
    check (kind in ('topic', 'rhythm', 'offer', 'audience')),
  constraint growth_moves_status_check
    check (status in ('open', 'done', 'skipped')),
  constraint growth_moves_confidence_check
    check (confidence in ('answered', 'hypothesis', 'insufficient_data')),
  constraint growth_moves_title_check
    check (char_length(btrim(title)) between 3 and 200),
  constraint growth_moves_reason_check
    check (char_length(reason) between 3 and 500),
  constraint growth_moves_prompt_check
    check (char_length(prompt) between 3 and 2000),
  constraint growth_moves_href_check
    check (char_length(action_href) between 3 and 400),
  constraint growth_moves_fingerprint_check
    check (fingerprint ~ '^[0-9a-f]{64}$'),
  constraint growth_moves_source_kind_check
    check (source_kind is null or source_kind in (
      'competitor_post', 'site_analysis', 'audience_question', 'stats'
    )),
  constraint growth_moves_missing_slots_check
    check (missing_slots is null or missing_slots between 1 and 20),
  constraint growth_moves_channel_week_fingerprint_uniq
    unique (channel_id, week_start, fingerprint)
);

create index if not exists growth_moves_channel_week_idx
  on growth_moves (channel_id, week_start, status, id);

commit;
