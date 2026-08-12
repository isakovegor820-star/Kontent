begin;

-- Media belongs to the selected project. user_id remains creator/actor metadata only.
alter table media_assets add column if not exists project_id bigint references projects (id) on delete restrict;
alter table media_assets add column if not exists origin text not null default 'legacy';
alter table media_assets add column if not exists width_px integer;
alter table media_assets add column if not exists height_px integer;
alter table media_assets add column if not exists metadata jsonb not null default '{}'::jsonb;
update media_assets asset
   set project_id = coalesce(
     (select project.id from projects project where project.personal_owner_user_id = asset.user_id),
     aurora_selected_project_for_user(asset.user_id)
   )
 where asset.project_id is null;
alter table media_assets alter column project_id set not null;
alter table media_assets add constraint media_assets_origin_check
  check (origin in ('legacy','upload','media_generation','legal_visual_render'));
alter table media_assets add constraint media_assets_dimensions_check check (
  (width_px is null and height_px is null)
  or (width_px > 0 and height_px > 0)
);
alter table media_assets add constraint media_assets_metadata_check
  check (jsonb_typeof(metadata) = 'object');
create unique index if not exists media_assets_id_project_uniq on media_assets (id, project_id);
create index if not exists media_assets_project_created_idx
  on media_assets (project_id, created_at desc, id desc);
create index if not exists media_assets_project_origin_created_idx
  on media_assets (project_id, origin, created_at desc, id desc);

alter table media_generations add column if not exists project_id bigint references projects (id) on delete restrict;
update media_generations generation
   set project_id = coalesce(
     (select project.id from projects project where project.personal_owner_user_id = generation.user_id),
     aurora_selected_project_for_user(generation.user_id)
   )
 where generation.project_id is null;
alter table media_generations alter column project_id set not null;
create unique index if not exists media_generations_id_project_uniq
  on media_generations (id, project_id);
create index if not exists media_generations_project_created_idx
  on media_generations (project_id, created_at desc, id desc);
drop index if exists media_generations_user_request_key_uniq;
create unique index if not exists media_generations_project_request_key_uniq
  on media_generations (project_id, request_key) where request_key is not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'media_generations'::regclass
       and conname = 'media_generations_output_asset_project_fk'
  ) then
    alter table media_generations
      add constraint media_generations_output_asset_project_fk
      foreign key (output_asset_id, project_id)
      references media_assets (id, project_id) on delete no action;
  end if;
end
$$;

-- Account avatars are not project media. Keeping them in a separate table prevents a
-- project switch from breaking the image and prevents project members from reusing it
-- as a post asset.
create table if not exists user_avatar_assets (
  id         bigint generated always as identity primary key,
  user_id    bigint not null references users (id) on delete cascade,
  file_name  text not null,
  mime_type  text not null check (mime_type in ('image/webp','image/png','image/jpeg')),
  bytes      integer not null check (bytes > 0 and bytes <= 5242880),
  data       bytea not null,
  sha256     char(64) not null check (sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  unique (user_id, sha256, mime_type)
);
create index if not exists user_avatar_assets_user_created_idx
  on user_avatar_assets (user_id, created_at desc, id desc);

with copied as (
  insert into user_avatar_assets (user_id, file_name, mime_type, bytes, data, sha256, created_at)
  select asset.user_id, asset.file_name, asset.mime_type, asset.bytes, asset.data, asset.sha256, asset.created_at
    from media_assets asset
    join users user_row on user_row.id = asset.user_id
   where user_row.avatar = '/api/media/assets/' || asset.id::text
     and asset.kind = 'image'
     and asset.storage_backend = 'postgres'
     and asset.data is not null
  on conflict (user_id, sha256, mime_type) do update set file_name = excluded.file_name
  returning id, user_id
)
update users user_row
   set avatar = '/api/settings/profile/avatar-assets/' || copied.id::text
  from copied
 where user_row.id = copied.user_id
   and user_row.avatar like '/api/media/assets/%';

-- Draft revisions already have a globally unique id. The wider key lets every
-- downstream artefact prove that revision, draft and project belong together.
alter table draft_revisions add constraint draft_revisions_lineage_uniq
  unique (id, project_id, draft_id, draft_version);

create table if not exists project_brand_kits (
  project_id       bigint primary key references projects (id) on delete cascade,
  name             varchar(100) not null,
  logo_asset_id    bigint,
  colors           jsonb not null,
  allowed_fonts    text[] not null,
  active_font      text not null,
  signature        varchar(160) not null default '',
  version          bigint not null default 1,
  created_by_user_id bigint not null references users (id) on delete restrict,
  updated_by_user_id bigint not null references users (id) on delete restrict,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint project_brand_kits_name_check check (length(btrim(name)) between 1 and 100),
  constraint project_brand_kits_colors_check check (
    jsonb_typeof(colors) = 'object'
    and colors ?& array['background','surface','text','mutedText','accent','critical']
    and (colors->>'background') ~ '^#[0-9a-f]{6}$'
    and (colors->>'surface') ~ '^#[0-9a-f]{6}$'
    and (colors->>'text') ~ '^#[0-9a-f]{6}$'
    and (colors->>'mutedText') ~ '^#[0-9a-f]{6}$'
    and (colors->>'accent') ~ '^#[0-9a-f]{6}$'
    and (colors->>'critical') ~ '^#[0-9a-f]{6}$'
  ),
  constraint project_brand_kits_fonts_check check (
    cardinality(allowed_fonts) between 1 and 3
    and allowed_fonts <@ array['aurora-sans','legal-serif','technical-mono']::text[]
    and active_font = any(allowed_fonts)
  ),
  constraint project_brand_kits_signature_check check (length(signature) <= 160),
  constraint project_brand_kits_version_check check (version > 0),
  constraint project_brand_kits_logo_project_fk
    foreign key (logo_asset_id, project_id)
    references media_assets (id, project_id) on delete restrict
);

create table if not exists legal_visual_designs (
  id                 bigint generated always as identity primary key,
  project_id         bigint not null references projects (id) on delete cascade,
  created_by_user_id bigint not null references users (id) on delete restrict,
  updated_by_user_id bigint not null references users (id) on delete restrict,
  source_draft_id    bigint,
  source_draft_revision_id bigint,
  source_draft_version bigint,
  source_content_hash char(64),
  name               varchar(160) not null,
  format             text not null,
  status             text not null default 'draft',
  revision           bigint not null default 1,
  config             jsonb not null,
  config_hash        char(64) not null,
  rendered_revision  bigint,
  request_key        varchar(96) not null,
  error_code         varchar(100),
  error_message      varchar(500),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint legal_visual_designs_name_check check (length(btrim(name)) between 1 and 160),
  constraint legal_visual_designs_format_check check (format in ('1:1','4:5','9:16')),
  constraint legal_visual_designs_status_check
    check (status in ('draft','render_queued','rendering','ready','render_failed')),
  constraint legal_visual_designs_revision_check
    check (revision > 0 and (rendered_revision is null or rendered_revision > 0)),
  constraint legal_visual_designs_config_check check (jsonb_typeof(config) = 'object'),
  constraint legal_visual_designs_hash_check check (config_hash ~ '^[0-9a-f]{64}$'),
  constraint legal_visual_designs_source_hash_check check (
    source_content_hash is null or source_content_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint legal_visual_designs_source_revision_check check (
    (source_draft_id is null and source_draft_revision_id is null
      and source_draft_version is null and source_content_hash is null)
    or (source_draft_id is not null and source_draft_revision_id is not null
      and source_draft_version > 0 and source_content_hash is not null)
  ),
  constraint legal_visual_designs_request_key_check
    check (request_key ~ '^[A-Za-z0-9:_-]{8,96}$'),
  constraint legal_visual_designs_source_draft_project_fk
    foreign key (source_draft_id, project_id)
    references drafts (id, project_id) on delete restrict,
  constraint legal_visual_designs_source_revision_project_fk
    foreign key (source_draft_revision_id, project_id, source_draft_id, source_draft_version)
    references draft_revisions (id, project_id, draft_id, draft_version) on delete restrict,
  unique (project_id, request_key),
  unique (id, project_id)
);
create index if not exists legal_visual_designs_project_updated_idx
  on legal_visual_designs (project_id, updated_at desc, id desc);
create index if not exists legal_visual_designs_source_draft_idx
  on legal_visual_designs (project_id, source_draft_id, updated_at desc)
  where source_draft_id is not null;

create table if not exists legal_visual_source_assets (
  design_id       bigint not null,
  project_id      bigint not null,
  card_id         varchar(128) not null,
  media_asset_id  bigint not null,
  role            text not null default 'illustration',
  created_at      timestamptz not null default now(),
  primary key (design_id, card_id, media_asset_id),
  constraint legal_visual_source_assets_design_project_fk
    foreign key (design_id, project_id)
    references legal_visual_designs (id, project_id) on delete cascade,
  constraint legal_visual_source_assets_asset_project_fk
    foreign key (media_asset_id, project_id)
    references media_assets (id, project_id) on delete restrict,
  constraint legal_visual_source_assets_card_check
    check (length(btrim(card_id)) between 1 and 128),
  constraint legal_visual_source_assets_role_check
    check (role in ('illustration','background')),
  unique (project_id, design_id, card_id)
);
create index if not exists legal_visual_source_assets_asset_idx
  on legal_visual_source_assets (project_id, media_asset_id, design_id);

create table if not exists legal_visual_render_operations (
  id                 bigint generated always as identity primary key,
  project_id         bigint not null references projects (id) on delete cascade,
  design_id          bigint not null,
  requested_by_user_id bigint not null references users (id) on delete restrict,
  design_revision    bigint not null,
  config_snapshot    jsonb not null,
  config_hash        char(64) not null,
  status             text not null default 'pending',
  attempts           integer not null default 0,
  idempotency_key    varchar(128) not null,
  error_code         varchar(100),
  error_message      varchar(500),
  started_at         timestamptz,
  completed_at       timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint legal_visual_render_operations_design_project_fk
    foreign key (design_id, project_id)
    references legal_visual_designs (id, project_id) on delete cascade,
  constraint legal_visual_render_operations_revision_check check (design_revision > 0),
  constraint legal_visual_render_operations_snapshot_check check (jsonb_typeof(config_snapshot) = 'object'),
  constraint legal_visual_render_operations_hash_check check (config_hash ~ '^[0-9a-f]{64}$'),
  constraint legal_visual_render_operations_status_check check (
    status in ('pending','queued','rendering','ready','retryable_failed','failed')
  ),
  constraint legal_visual_render_operations_attempts_check check (attempts >= 0),
  constraint legal_visual_render_operations_completion_check check (
    (status in ('ready','failed') and completed_at is not null)
    or (status not in ('ready','failed') and completed_at is null)
  ),
  unique (project_id, idempotency_key),
  unique (design_id, design_revision, config_hash),
  unique (id, project_id),
  unique (id, project_id, design_id)
);
create index if not exists legal_visual_render_operations_project_status_idx
  on legal_visual_render_operations (project_id, status, updated_at desc, id desc);

create table if not exists legal_visual_render_cards (
  operation_id   bigint not null,
  project_id     bigint not null,
  design_id      bigint not null,
  card_id        varchar(128) not null,
  card_order     integer not null,
  media_asset_id bigint not null,
  sha256         char(64) not null,
  width          integer not null,
  height         integer not null,
  created_at     timestamptz not null default now(),
  primary key (operation_id, card_order),
  constraint legal_visual_render_cards_operation_project_fk
    foreign key (operation_id, project_id, design_id)
    references legal_visual_render_operations (id, project_id, design_id) on delete cascade,
  constraint legal_visual_render_cards_asset_project_fk
    foreign key (media_asset_id, project_id)
    references media_assets (id, project_id) on delete restrict,
  constraint legal_visual_render_cards_order_check check (card_order between 1 and 7),
  constraint legal_visual_render_cards_id_check check (length(btrim(card_id)) between 1 and 128),
  constraint legal_visual_render_cards_hash_check check (sha256 ~ '^[0-9a-f]{64}$'),
  constraint legal_visual_render_cards_dimensions_check check (width > 0 and height > 0),
  unique (project_id, operation_id, card_id),
  unique (media_asset_id)
);
create index if not exists legal_visual_render_cards_design_idx
  on legal_visual_render_cards (project_id, design_id, operation_id, card_order);

create table if not exists legal_visual_render_outbox (
  id               bigint generated always as identity primary key,
  operation_id     bigint not null,
  project_id       bigint not null,
  status           text not null default 'pending',
  attempts         integer not null default 0,
  next_attempt_at  timestamptz not null default now(),
  lease_token      uuid,
  lease_expires_at timestamptz,
  enqueued_at      timestamptz,
  last_error_code  varchar(100),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint legal_visual_render_outbox_operation_project_fk
    foreign key (operation_id, project_id)
    references legal_visual_render_operations (id, project_id) on delete cascade,
  constraint legal_visual_render_outbox_status_check check (
    status in ('pending','dispatching','enqueued','retryable_failed','failed','completed','cancelled')
  ),
  constraint legal_visual_render_outbox_attempts_check check (attempts >= 0),
  constraint legal_visual_render_outbox_lease_check check (
    (status = 'dispatching' and lease_token is not null and lease_expires_at is not null)
    or (status <> 'dispatching' and lease_token is null and lease_expires_at is null)
  ),
  unique (operation_id),
  unique (project_id, operation_id)
);
create index if not exists legal_visual_render_outbox_due_idx
  on legal_visual_render_outbox (next_attempt_at, id)
  where status in ('pending','retryable_failed','enqueued');

create table if not exists legal_video_scripts (
  id                 bigint generated always as identity primary key,
  project_id         bigint not null references projects (id) on delete cascade,
  source_draft_id    bigint not null,
  source_draft_revision_id bigint not null,
  source_draft_version bigint not null,
  source_content_hash char(64) not null,
  created_by_user_id bigint not null references users (id) on delete restrict,
  updated_by_user_id bigint not null references users (id) on delete restrict,
  title              varchar(180) not null,
  duration_seconds   integer not null,
  revision           bigint not null default 1,
  revision_hash      char(64) not null,
  snapshot           jsonb not null,
  request_key        varchar(96) not null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint legal_video_scripts_source_draft_project_fk
    foreign key (source_draft_id, project_id)
    references drafts (id, project_id) on delete restrict,
  constraint legal_video_scripts_source_revision_project_fk
    foreign key (source_draft_revision_id, project_id, source_draft_id, source_draft_version)
    references draft_revisions (id, project_id, draft_id, draft_version) on delete restrict,
  constraint legal_video_scripts_title_check check (length(btrim(title)) between 1 and 180),
  constraint legal_video_scripts_duration_check check (duration_seconds in (30,45,60)),
  constraint legal_video_scripts_revision_check check (revision > 0 and source_draft_version > 0),
  constraint legal_video_scripts_hash_check check (
    revision_hash ~ '^[0-9a-f]{64}$' and source_content_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint legal_video_scripts_snapshot_check check (jsonb_typeof(snapshot) = 'object'),
  constraint legal_video_scripts_request_key_check check (request_key ~ '^[A-Za-z0-9:_-]{8,96}$'),
  unique (project_id, request_key),
  unique (id, project_id)
);
create index if not exists legal_video_scripts_project_updated_idx
  on legal_video_scripts (project_id, updated_at desc, id desc);
create index if not exists legal_video_scripts_source_draft_idx
  on legal_video_scripts (project_id, source_draft_id, updated_at desc, id desc);

create table if not exists legal_video_script_revisions (
  id             bigint generated always as identity primary key,
  script_id      bigint not null,
  project_id     bigint not null,
  revision       bigint not null,
  revision_hash  char(64) not null,
  snapshot       jsonb not null,
  actor_user_id  bigint not null references users (id) on delete restrict,
  created_at     timestamptz not null default now(),
  constraint legal_video_script_revisions_script_project_fk
    foreign key (script_id, project_id)
    references legal_video_scripts (id, project_id) on delete cascade,
  constraint legal_video_script_revisions_revision_check check (revision > 0),
  constraint legal_video_script_revisions_hash_check check (revision_hash ~ '^[0-9a-f]{64}$'),
  constraint legal_video_script_revisions_snapshot_check check (jsonb_typeof(snapshot) = 'object'),
  unique (script_id, revision),
  unique (project_id, script_id, revision_hash)
);
create index if not exists legal_video_script_revisions_project_idx
  on legal_video_script_revisions (project_id, script_id, revision desc);

create or replace function aurora_reject_legal_video_revision_update()
returns trigger
language plpgsql
as $$
begin
  raise exception 'legal_video_revision_immutable' using errcode = '55000';
end
$$;

do $$
begin
  if not exists (
    select 1 from pg_trigger where tgname = 'legal_video_script_revisions_immutable_update'
  ) then
    create trigger legal_video_script_revisions_immutable_update
      before update on legal_video_script_revisions for each row
      execute function aurora_reject_legal_video_revision_update();
  end if;
end
$$;

commit;
