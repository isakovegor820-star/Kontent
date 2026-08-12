begin;

-- Project-owned UTM presets. UTM values are validated again in application code;
-- the database keeps only normalized structured values, never arbitrary query blobs.
create table if not exists project_utm_templates (
  id                 bigint generated always as identity primary key,
  project_id         bigint not null references projects (id) on delete cascade,
  name               varchar(120) not null,
  values             jsonb not null default '{}'::jsonb,
  version            bigint not null default 1,
  is_archived        boolean not null default false,
  created_by_user_id bigint not null references users (id) on delete restrict,
  updated_by_user_id bigint not null references users (id) on delete restrict,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint project_utm_templates_name_check check (length(btrim(name)) between 1 and 120),
  constraint project_utm_templates_values_check check (jsonb_typeof(values) = 'object'),
  constraint project_utm_templates_version_check check (version > 0),
  unique (id, project_id)
);
create unique index if not exists project_utm_templates_active_name_uniq
  on project_utm_templates (project_id, lower(btrim(name))) where is_archived = false;
create index if not exists project_utm_templates_project_idx
  on project_utm_templates (project_id, is_archived, updated_at desc, id desc);

-- Explicit readiness prevents a real zero from being confused with an absent
-- first-party tracker. No script token or personal data is stored here.
create table if not exists project_tracking_settings (
  project_id             bigint primary key references projects (id) on delete cascade,
  status                 text not null default 'not_connected',
  site_origin            text,
  public_key             varchar(64) unique,
  attribution_window_days smallint not null default 30,
  version                bigint not null default 1,
  updated_by_user_id     bigint references users (id) on delete set null,
  verified_at            timestamptz,
  last_ping_at           timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint project_tracking_settings_status_check
    check (status in ('not_connected','active','paused','verification_failed')),
  constraint project_tracking_settings_origin_check
    check (site_origin is null or site_origin ~ '^https?://[^/?#]+$'),
  constraint project_tracking_settings_public_key_check
    check (public_key is null or public_key ~ '^[A-Za-z0-9_-]{20,64}$'),
  constraint project_tracking_settings_window_check check (attribution_window_days between 1 and 90),
  constraint project_tracking_settings_version_check check (version > 0),
  constraint project_tracking_settings_readiness_check check (
    (status = 'active' and site_origin is not null and public_key is not null and verified_at is not null)
    or status <> 'active'
  )
);

-- The destination is server-owned after creation. The public redirect resolves a
-- random slug only; a request can never supply a destination at redirect time.
create table if not exists short_links (
  id                 bigint generated always as identity primary key,
  project_id         bigint not null references projects (id) on delete cascade,
  created_by_user_id bigint not null references users (id) on delete restrict,
  request_key        varchar(128) not null,
  request_hash       char(64) not null,
  template_id        bigint,
  slug               varchar(64) not null unique,
  destination_url    text not null,
  destination_hash   char(64) not null,
  utm_values         jsonb not null default '{}'::jsonb,
  status             text not null default 'active',
  version            bigint not null default 1,
  expires_at         timestamptz,
  revoked_at         timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint short_links_slug_check check (slug ~ '^[A-Za-z0-9_-]{20,64}$'),
  constraint short_links_request_key_check check (length(btrim(request_key)) between 8 and 128),
  constraint short_links_request_hash_check check (request_hash ~ '^[0-9a-f]{64}$'),
  constraint short_links_destination_check check (destination_url ~ '^https?://'),
  constraint short_links_destination_hash_check check (destination_hash ~ '^[0-9a-f]{64}$'),
  constraint short_links_utm_check check (jsonb_typeof(utm_values) = 'object'),
  constraint short_links_status_check check (status in ('active','revoked','expired')),
  constraint short_links_version_check check (version > 0),
  constraint short_links_revocation_check check (
    (status = 'revoked' and revoked_at is not null)
    or (status <> 'revoked' and revoked_at is null)
  ),
  constraint short_links_template_project_fk foreign key (template_id, project_id)
    references project_utm_templates (id, project_id) on delete restrict,
  unique (project_id, created_by_user_id, request_key),
  unique (id, project_id)
);
create index if not exists short_links_project_created_idx
  on short_links (project_id, created_at desc, id desc);
create index if not exists short_links_active_expiry_idx
  on short_links (expires_at, id) where status = 'active';

-- One row per short-link/day fingerprint provides an exact unique denominator
-- while the click ledger below still records every visit.
create table if not exists short_link_unique_visitors (
  project_id      bigint not null references projects (id) on delete cascade,
  short_link_id   bigint not null references short_links (id) on delete cascade,
  dedupe_key      char(64) not null,
  first_seen_at   timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),
  primary key (short_link_id, dedupe_key),
  constraint short_link_unique_visitors_key_check check (dedupe_key ~ '^[0-9a-f]{64}$'),
  constraint short_link_unique_visitors_link_project_fk foreign key (short_link_id, project_id)
    references short_links (id, project_id) on delete cascade
);
create index if not exists short_link_unique_visitors_project_idx
  on short_link_unique_visitors (project_id, first_seen_at desc, short_link_id);

-- No raw IP address or complete user-agent string is retained. visitor_hash and
-- dedupe_key are keyed hashes produced by the server and cannot be reversed.
create table if not exists short_link_clicks (
  id                  uuid primary key default gen_random_uuid(),
  project_id          bigint not null references projects (id) on delete cascade,
  short_link_id       bigint not null references short_links (id) on delete cascade,
  visitor_hash        char(64) not null,
  dedupe_key          char(64) not null,
  is_unique           boolean not null,
  is_likely_bot       boolean not null default false,
  client_class        varchar(40) not null default 'browser',
  referrer_host       varchar(253),
  occurred_at         timestamptz not null default now(),
  attribution_expires_at timestamptz not null,
  constraint short_link_clicks_visitor_hash_check check (visitor_hash ~ '^[0-9a-f]{64}$'),
  constraint short_link_clicks_dedupe_key_check check (dedupe_key ~ '^[0-9a-f]{64}$'),
  constraint short_link_clicks_client_class_check
    check (client_class in ('browser','preview','crawler','unknown')),
  constraint short_link_clicks_referrer_check
    check (referrer_host is null or length(referrer_host) between 1 and 253),
  constraint short_link_clicks_attribution_check check (attribution_expires_at > occurred_at),
  constraint short_link_clicks_link_project_fk foreign key (short_link_id, project_id)
    references short_links (id, project_id) on delete cascade,
  unique (id, short_link_id, project_id)
);
create index if not exists short_link_clicks_project_time_idx
  on short_link_clicks (project_id, occurred_at desc, id);
create index if not exists short_link_clicks_link_time_idx
  on short_link_clicks (short_link_id, occurred_at desc, id);
create index if not exists short_link_clicks_human_idx
  on short_link_clicks (project_id, short_link_id, occurred_at desc)
  where is_likely_bot = false;

-- Only events with a valid signed attribution token are inserted. Repeating the
-- same first-party event with one idempotency key returns the stored result.
create table if not exists conversion_events (
  id                    uuid primary key default gen_random_uuid(),
  project_id            bigint not null references projects (id) on delete cascade,
  short_link_id         bigint not null references short_links (id) on delete cascade,
  click_id              uuid not null references short_link_clicks (id) on delete restrict,
  event_type            text not null,
  idempotency_hash      char(64) not null,
  request_hash          char(64) not null,
  attribution_token_hash char(64) not null,
  occurred_at           timestamptz not null,
  received_at           timestamptz not null default now(),
  safe_properties       jsonb not null default '{}'::jsonb,
  constraint conversion_events_type_check
    check (event_type in ('form_open','form_submit','consultation_booked')),
  constraint conversion_events_idempotency_hash_check check (idempotency_hash ~ '^[0-9a-f]{64}$'),
  constraint conversion_events_request_hash_check check (request_hash ~ '^[0-9a-f]{64}$'),
  constraint conversion_events_token_hash_check check (attribution_token_hash ~ '^[0-9a-f]{64}$'),
  constraint conversion_events_properties_check check (jsonb_typeof(safe_properties) = 'object'),
  constraint conversion_events_clock_check check (occurred_at <= received_at + interval '5 minutes'),
  constraint conversion_events_link_project_fk foreign key (short_link_id, project_id)
    references short_links (id, project_id) on delete cascade,
  constraint conversion_events_click_link_project_fk foreign key (click_id, short_link_id, project_id)
    references short_link_clicks (id, short_link_id, project_id) on delete restrict,
  unique (project_id, idempotency_hash)
);
create index if not exists conversion_events_project_time_idx
  on conversion_events (project_id, occurred_at desc, id);
create index if not exists conversion_events_link_time_idx
  on conversion_events (short_link_id, occurred_at desc, id);

-- Exact tracking configuration used for one publication revision. It is immutable
-- application evidence just like publication text/media snapshots.
create unique index if not exists publication_operations_id_project_uniq
  on publication_operations (id, project_id);
create unique index if not exists posts_id_project_uniq on posts (id, project_id);
create table if not exists publication_tracking_snapshots (
  id                       bigint generated always as identity primary key,
  project_id               bigint not null references projects (id) on delete restrict,
  publication_operation_id bigint not null references publication_operations (id) on delete cascade,
  post_id                  bigint not null references posts (id) on delete cascade,
  short_link_id            bigint,
  placement                varchar(80) not null,
  destination_url          text not null,
  short_url_path           varchar(80),
  utm_values               jsonb not null default '{}'::jsonb,
  snapshot_hash            char(64) not null,
  created_at               timestamptz not null default now(),
  constraint publication_tracking_placement_check check (length(btrim(placement)) between 1 and 80),
  constraint publication_tracking_destination_check check (destination_url ~ '^https?://'),
  constraint publication_tracking_short_path_check
    check (short_url_path is null or short_url_path ~ '^/r/[A-Za-z0-9_-]{20,64}$'),
  constraint publication_tracking_utm_check check (jsonb_typeof(utm_values) = 'object'),
  constraint publication_tracking_hash_check check (snapshot_hash ~ '^[0-9a-f]{64}$'),
  constraint publication_tracking_operation_project_fk foreign key (publication_operation_id, project_id)
    references publication_operations (id, project_id) on delete cascade,
  constraint publication_tracking_post_project_fk foreign key (post_id, project_id)
    references posts (id, project_id) on delete cascade,
  constraint publication_tracking_link_project_fk foreign key (short_link_id, project_id)
    references short_links (id, project_id) on delete restrict,
  unique (post_id, placement)
);
create index if not exists publication_tracking_project_idx
  on publication_tracking_snapshots (project_id, created_at desc, id desc);
create index if not exists publication_tracking_operation_idx
  on publication_tracking_snapshots (publication_operation_id, post_id, placement);

-- Composer persists the structured tracking choice with the editable draft. The
-- editorial revision builder hashes this field, so changing a link invalidates an
-- earlier approval exactly like changing the text.
alter table drafts add column if not exists tracking jsonb not null default '{}'::jsonb;
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'drafts_tracking_object_check'
  ) then
    alter table drafts add constraint drafts_tracking_object_check
      check (jsonb_typeof(tracking) = 'object');
  end if;
end
$$;

-- Large project exports use a durable outbox and a short-lived, hashed download
-- token. The immutable snapshot is shared by CSV, XLSX and PDF renderers.
create table if not exists project_export_operations (
  id                 bigint generated always as identity primary key,
  project_id         bigint not null references projects (id) on delete cascade,
  requested_by_user_id bigint not null references users (id) on delete restrict,
  export_kind        text not null,
  format             text not null,
  request_key        varchar(128) not null,
  request_hash       char(64) not null,
  filters            jsonb not null default '{}'::jsonb,
  snapshot           jsonb not null,
  snapshot_hash      char(64) not null,
  status             text not null default 'pending',
  error_code         varchar(100),
  error_message      varchar(500),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  completed_at       timestamptz,
  constraint project_export_operations_kind_check check (export_kind in ('content_plan','analytics')),
  constraint project_export_operations_format_check check (format in ('csv','xlsx','pdf')),
  constraint project_export_operations_request_hash_check check (request_hash ~ '^[0-9a-f]{64}$'),
  constraint project_export_operations_filters_check check (jsonb_typeof(filters) = 'object'),
  constraint project_export_operations_snapshot_check check (jsonb_typeof(snapshot) = 'object'),
  constraint project_export_operations_snapshot_hash_check check (snapshot_hash ~ '^[0-9a-f]{64}$'),
  constraint project_export_operations_status_check
    check (status in ('pending','queued','rendering','ready','retryable_failed','failed','expired')),
  unique (project_id, requested_by_user_id, request_key),
  unique (id, project_id)
);
create index if not exists project_export_operations_project_idx
  on project_export_operations (project_id, created_at desc, id desc);
create index if not exists project_export_operations_active_idx
  on project_export_operations (status, updated_at, id)
  where status in ('pending','queued','rendering','retryable_failed');

create table if not exists project_export_artifacts (
  id                 bigint generated always as identity primary key,
  operation_id       bigint not null unique references project_export_operations (id) on delete cascade,
  project_id         bigint not null references projects (id) on delete cascade,
  file_name          varchar(240) not null,
  mime_type          varchar(120) not null,
  byte_size          bigint not null,
  sha256             char(64) not null,
  storage_backend    text not null default 'postgres',
  data               bytea,
  object_key         text,
  object_etag        text,
  created_at         timestamptz not null default now(),
  expires_at         timestamptz not null default (now() + interval '24 hours'),
  constraint project_export_artifacts_size_check check (byte_size >= 0),
  constraint project_export_artifacts_hash_check check (sha256 ~ '^[0-9a-f]{64}$'),
  constraint project_export_artifacts_storage_check check (storage_backend in ('postgres','object')),
  constraint project_export_artifacts_payload_check check (
    (storage_backend = 'postgres' and data is not null and object_key is null)
    or (storage_backend = 'object' and data is null and object_key is not null)
  ),
  constraint project_export_artifacts_expiry_check check (expires_at > created_at),
  constraint project_export_artifacts_operation_project_fk foreign key (operation_id, project_id)
    references project_export_operations (id, project_id) on delete cascade,
  unique (id, project_id)
);
create index if not exists project_export_artifacts_expiry_idx
  on project_export_artifacts (expires_at, id);
create unique index if not exists project_export_artifacts_object_key_uniq
  on project_export_artifacts (object_key) where object_key is not null;

create table if not exists project_export_download_tokens (
  id                 bigint generated always as identity primary key,
  project_id         bigint not null references projects (id) on delete cascade,
  artifact_id        bigint not null references project_export_artifacts (id) on delete cascade,
  requested_by_user_id bigint not null references users (id) on delete cascade,
  token_hash         char(64) not null unique,
  expires_at         timestamptz not null,
  revoked_at         timestamptz,
  last_downloaded_at timestamptz,
  created_at         timestamptz not null default now(),
  constraint project_export_download_tokens_hash_check check (token_hash ~ '^[0-9a-f]{64}$'),
  constraint project_export_download_tokens_ttl_check check (expires_at > created_at),
  constraint project_export_download_tokens_artifact_project_fk foreign key (artifact_id, project_id)
    references project_export_artifacts (id, project_id) on delete cascade
);
create index if not exists project_export_download_tokens_expiry_idx
  on project_export_download_tokens (expires_at, id) where revoked_at is null;

create table if not exists project_export_outbox (
  id               bigint generated always as identity primary key,
  operation_id     bigint not null unique references project_export_operations (id) on delete cascade,
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
  constraint project_export_outbox_status_check
    check (status in ('pending','dispatching','enqueued','retryable_failed','failed','cancelled')),
  constraint project_export_outbox_attempts_check check (attempts >= 0),
  constraint project_export_outbox_lease_check check (
    (lease_token is null and lease_expires_at is null)
    or (lease_token is not null and lease_expires_at is not null)
  ),
  constraint project_export_outbox_operation_project_fk foreign key (operation_id, project_id)
    references project_export_operations (id, project_id) on delete cascade
);
create index if not exists project_export_outbox_due_idx
  on project_export_outbox (next_attempt_at, id)
  where status in ('pending','retryable_failed');

commit;
