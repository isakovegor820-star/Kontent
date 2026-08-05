-- Dedicated, licensed legal-source storage. Public ConsultantPlus/GARANT RSS feeds
-- remain in the versioned RSS catalog and do not need credentials. Provider endpoints
-- are server configuration only; the database stores encrypted token envelopes.

begin;

create table if not exists legal_source_connections (
  id                     bigint generated always as identity primary key,
  user_id                bigint not null references users (id) on delete cascade,
  provider_id            varchar(64) not null,
  provider_label         varchar(120) not null,
  integration_kind       varchar(32) not null,
  token_envelope         text,
  status                 varchar(24) not null default 'connected',
  subscription_status    varchar(24) not null default 'unknown',
  external_account_label varchar(300),
  token_expires_at       timestamptz,
  sync_cursor            text,
  last_sync_at           timestamptz,
  last_health_at         timestamptz,
  last_error_code        varchar(80),
  last_error_message     varchar(500),
  disconnected_at        timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint legal_source_connections_user_provider_key unique (user_id, provider_id),
  constraint legal_source_connections_provider_id_check
    check (provider_id ~ '^[a-z0-9][a-z0-9_-]{1,62}$'),
  constraint legal_source_connections_kind_check
    check (integration_kind in ('official_api','vendor_export','user_file','licensed_integration')),
  constraint legal_source_connections_status_check
    check (status in ('connected','invalid','expired','disconnected')),
  constraint legal_source_connections_subscription_check
    check (subscription_status in ('active','trial','expired','inactive','unknown')),
  constraint legal_source_connections_token_check
    check (
      status = 'disconnected'
      or integration_kind in ('vendor_export','user_file')
      or token_envelope is not null
    )
);
create index if not exists legal_source_connections_user_idx
  on legal_source_connections (user_id, updated_at desc);

-- A stable operation key fences paid/vendor requests. A dispatch lease prevents two
-- concurrent browser retries; an expired lease may retry the same vendor idempotency key.
create table if not exists legal_source_operations (
  id                  bigint generated always as identity primary key,
  user_id             bigint not null references users (id) on delete cascade,
  connection_id       bigint references legal_source_connections (id) on delete set null,
  provider_id         varchar(64) not null,
  operation           varchar(24) not null,
  request_key         varchar(128) not null,
  request_fingerprint char(64) not null,
  status              varchar(24) not null default 'dispatching',
  lease_token         uuid,
  lease_expires_at    timestamptz,
  result_payload      jsonb,
  http_status         smallint,
  last_error_code     varchar(80),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint legal_source_operations_user_request_key unique (user_id, request_key),
  constraint legal_source_operations_operation_check
    check (operation in ('connect','validate','sync','health','disconnect')),
  constraint legal_source_operations_status_check
    check (status in ('dispatching','succeeded','failed')),
  constraint legal_source_operations_fingerprint_check
    check (request_fingerprint ~ '^[a-f0-9]{64}$'),
  constraint legal_source_operations_result_check
    check (
      (status = 'dispatching' and result_payload is null and http_status is null)
      or (status <> 'dispatching' and jsonb_typeof(result_payload) = 'object' and http_status between 200 and 599)
    )
);
create index if not exists legal_source_operations_dispatch_idx
  on legal_source_operations (lease_expires_at, id) where status = 'dispatching';

-- Legal data never shares the generic knowledge table. Every fragment carries its own
-- type and provenance so an answer can cite the exact source, date, currentness and URL.
create table if not exists legal_source_fragments (
  id                    bigint generated always as identity primary key,
  user_id               bigint not null references users (id) on delete cascade,
  connection_id         bigint references legal_source_connections (id) on delete cascade,
  provider_id           varchar(64) not null,
  external_id           varchar(300) not null,
  fragment_index        integer not null,
  legal_type            varchar(24) not null,
  title                 varchar(1000) not null,
  content               text not null,
  source_name           varchar(300) not null,
  source_date           timestamptz not null,
  currentness           varchar(24) not null,
  source_url            text not null,
  relevant_at           timestamptz,
  metadata              jsonb not null default '{}'::jsonb,
  synced_at             timestamptz not null default now(),
  constraint legal_source_fragments_identity_key
    unique (user_id, provider_id, external_id, fragment_index),
  constraint legal_source_fragments_index_check check (fragment_index >= 0),
  constraint legal_source_fragments_type_check
    check (legal_type in ('law','case','commentary','document')),
  constraint legal_source_fragments_currentness_check
    check (currentness in ('current','superseded','unknown')),
  constraint legal_source_fragments_content_check
    check (length(btrim(content)) > 0),
  constraint legal_source_fragments_source_url_check
    check (source_url ~ '^https://')
);
create index if not exists legal_source_fragments_lookup_idx
  on legal_source_fragments (user_id, legal_type, source_date desc, id desc);
create index if not exists legal_source_fragments_connection_idx
  on legal_source_fragments (connection_id, synced_at desc);

commit;
