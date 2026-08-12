begin;

-- One monotonic dictionary version per project. Publication snapshots persist this
-- version together with the deterministic rules version used for the final recheck.
create table if not exists project_brand_dictionaries (
  project_id         bigint primary key references projects (id) on delete cascade,
  version            bigint not null default 1,
  created_by_user_id bigint not null references users (id) on delete restrict,
  updated_by_user_id bigint not null references users (id) on delete restrict,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint project_brand_dictionaries_version_check check (version > 0)
);
insert into project_brand_dictionaries (
  project_id, version, created_by_user_id, updated_by_user_id, created_at, updated_at
)
select project.id, 1, project.created_by_user_id, project.created_by_user_id,
       project.created_at, project.updated_at
  from projects project
on conflict (project_id) do nothing;

-- Entries are soft-deleted so an audit event and an old publication snapshot can
-- still identify the exact rule that existed at an earlier dictionary version.
create table if not exists project_brand_dictionary_entries (
  id                 bigint generated always as identity primary key,
  project_id         bigint not null references projects (id) on delete cascade,
  kind               text not null,
  term               varchar(240) not null,
  replacement        varchar(240),
  expansion          varchar(500),
  case_sensitive     boolean not null default false,
  is_active          boolean not null default true,
  version            bigint not null default 1,
  created_by_user_id bigint not null references users (id) on delete restrict,
  updated_by_user_id bigint not null references users (id) on delete restrict,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint project_brand_dictionary_entries_kind_check check (
    kind in ('canonical','allowed','prohibited','exception','abbreviation')
  ),
  constraint project_brand_dictionary_entries_term_check check (
    length(btrim(term)) between 1 and 240 and term = btrim(term)
  ),
  constraint project_brand_dictionary_entries_replacement_check check (
    (
      kind in ('canonical','prohibited','abbreviation')
      and replacement is not null
      and length(btrim(replacement)) between 1 and 240
      and replacement = btrim(replacement)
    )
    or (kind in ('allowed','exception') and replacement is null)
  ),
  constraint project_brand_dictionary_entries_expansion_check check (
    expansion is null or (length(btrim(expansion)) between 1 and 500 and expansion = btrim(expansion))
  ),
  constraint project_brand_dictionary_entries_version_check check (version > 0),
  unique (id, project_id)
);
create unique index if not exists project_brand_dictionary_entries_active_term_uniq
  on project_brand_dictionary_entries (project_id, kind, lower(term))
  where is_active;
create index if not exists project_brand_dictionary_entries_project_idx
  on project_brand_dictionary_entries (project_id, is_active desc, kind, lower(term), id);

-- Every explicit apply/reject is server-rechecked and durable. Source/result text is
-- bounded to the Composer limit so an accepted run can be undone after a save, while
-- hashes make publication comparison cheap and deterministic.
create table if not exists project_typography_runs (
  id                    bigint generated always as identity primary key,
  project_id            bigint not null references projects (id) on delete cascade,
  actor_user_id         bigint not null references users (id) on delete restrict,
  draft_id              bigint,
  request_key           varchar(96) not null,
  rules_version         varchar(80) not null,
  dictionary_version    bigint not null,
  source_text           text not null,
  result_text           text not null,
  source_text_hash      char(64) not null,
  result_text_hash      char(64) not null,
  suggestions           jsonb not null,
  accepted_suggestion_ids jsonb not null default '[]'::jsonb,
  rejected_suggestion_ids jsonb not null default '[]'::jsonb,
  review_complete       boolean not null default false,
  undone_at             timestamptz,
  undone_by_user_id     bigint references users (id) on delete restrict,
  created_at            timestamptz not null default now(),
  constraint project_typography_runs_draft_project_fk foreign key (draft_id, project_id)
    references drafts (id, project_id) on delete cascade,
  constraint project_typography_runs_request_key_check check (length(btrim(request_key)) between 16 and 96),
  constraint project_typography_runs_rules_version_check check (length(btrim(rules_version)) between 1 and 80),
  constraint project_typography_runs_dictionary_version_check check (dictionary_version > 0),
  constraint project_typography_runs_source_length_check check (length(source_text) between 1 and 50000),
  constraint project_typography_runs_result_length_check check (length(result_text) between 1 and 50000),
  constraint project_typography_runs_source_hash_check check (source_text_hash ~ '^[0-9a-f]{64}$'),
  constraint project_typography_runs_result_hash_check check (result_text_hash ~ '^[0-9a-f]{64}$'),
  constraint project_typography_runs_suggestions_check check (jsonb_typeof(suggestions) = 'array'),
  constraint project_typography_runs_accepted_check check (jsonb_typeof(accepted_suggestion_ids) = 'array'),
  constraint project_typography_runs_rejected_check check (jsonb_typeof(rejected_suggestion_ids) = 'array'),
  constraint project_typography_runs_undo_check check (
    (undone_at is null and undone_by_user_id is null)
    or (undone_at is not null and undone_by_user_id is not null)
  ),
  unique (project_id, request_key),
  unique (id, project_id)
);
create index if not exists project_typography_runs_draft_created_idx
  on project_typography_runs (project_id, draft_id, created_at desc, id desc)
  where draft_id is not null;
create index if not exists project_typography_runs_review_hash_idx
  on project_typography_runs
    (project_id, dictionary_version, rules_version, result_text_hash, created_at desc, id desc)
  where review_complete and undone_at is null;

commit;
