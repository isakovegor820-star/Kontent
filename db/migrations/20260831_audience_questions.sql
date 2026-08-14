begin;

-- Questions are editorial demand, not an inbox copy. The aggregate keeps one
-- project-scoped question while immutable submissions preserve where and when
-- people asked it. Exact normalized duplicates increase demand instead of
-- creating another card in the queue.
create table if not exists audience_questions (
  id                     bigint generated always as identity primary key,
  project_id             bigint       not null references projects (id) on delete cascade,
  created_by_user_id     bigint       not null references users (id) on delete restrict,
  question               text         not null check (char_length(question) between 3 and 600),
  question_fingerprint   char(64)     not null check (question_fingerprint ~ '^[0-9a-f]{64}$'),
  topic                  varchar(160),
  priority               smallint     not null default 2 check (priority between 1 and 3),
  occurrences            integer      not null default 1 check (occurrences between 1 and 1000000),
  status                 text         not null default 'new'
                                      check (status in ('new','drafting','planned','answered','dismissed')),
  generation_request_key varchar(128),
  draft_client_key       varchar(160),
  answer_draft_id        bigint references drafts (id) on delete set null,
  version                bigint       not null default 1 check (version > 0),
  first_seen_at          timestamptz  not null default now(),
  last_seen_at           timestamptz  not null default now(),
  answered_at            timestamptz,
  created_at             timestamptz  not null default now(),
  updated_at             timestamptz  not null default now(),
  unique (project_id, question_fingerprint),
  check ((generation_request_key is null) = (draft_client_key is null)),
  check ((status = 'answered') = (answered_at is not null))
);

create index if not exists audience_questions_project_queue_idx
  on audience_questions (project_id, status, priority desc, occurrences desc, last_seen_at desc);
create index if not exists audience_questions_project_topic_idx
  on audience_questions (project_id, topic, last_seen_at desc)
  where topic is not null;

create table if not exists audience_question_occurrences (
  id                 bigint generated always as identity primary key,
  project_id         bigint       not null references projects (id) on delete cascade,
  question_id        bigint       not null references audience_questions (id) on delete cascade,
  submitted_by_user_id bigint     not null references users (id) on delete restrict,
  request_key        varchar(128) not null,
  source_type        text         not null
                                  check (source_type in ('manual','comment','direct_message','support','sales','search','other')),
  source_label       varchar(200),
  source_url         text,
  context            text,
  occurrence_count   integer      not null default 1 check (occurrence_count between 1 and 10000),
  occurred_at        timestamptz  not null default now(),
  created_at         timestamptz  not null default now(),
  unique (project_id, request_key)
);

create index if not exists audience_question_occurrences_question_idx
  on audience_question_occurrences (question_id, occurred_at desc, id desc);

commit;
