begin;

-- A project is the tenant boundary for collaborative work. Every legacy account gets
-- one personal project; the existing user_id columns remain the actor/creator
-- attribution and are intentionally not removed.
create table if not exists projects (
  id                     bigint generated always as identity primary key,
  name                   varchar(160) not null,
  timezone               varchar(80) not null default 'UTC',
  created_by_user_id     bigint references users (id) on delete set null,
  personal_owner_user_id bigint unique references users (id) on delete cascade,
  is_archived            boolean not null default false,
  version                bigint not null default 1,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint projects_name_check check (length(btrim(name)) between 1 and 160),
  constraint projects_timezone_check check (length(btrim(timezone)) between 1 and 80),
  constraint projects_version_check check (version > 0)
);

create table if not exists project_members (
  project_id bigint not null references projects (id) on delete cascade,
  user_id    bigint not null references users (id) on delete cascade,
  role       text not null,
  status     text not null default 'active',
  version    bigint not null default 1,
  joined_at  timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revoked_at timestamptz,
  primary key (project_id, user_id),
  constraint project_members_role_check
    check (role in ('owner','author','approver','publisher')),
  constraint project_members_status_check check (status in ('active','revoked')),
  constraint project_members_version_check check (version > 0),
  constraint project_members_revocation_check check (
    (status = 'active' and revoked_at is null)
    or (status = 'revoked' and revoked_at is not null)
  )
);
create index if not exists project_members_user_active_idx
  on project_members (user_id, project_id) where status = 'active';
create index if not exists project_members_project_role_idx
  on project_members (project_id, role, user_id) where status = 'active';

-- Invitation secrets never enter PostgreSQL. Only a SHA-256 token hash is stored.
-- Validity is derived from expires_at/accepted_at/revoked_at, so stale invitations
-- cannot accidentally become active again through a loose status update.
create table if not exists project_invitations (
  id                 bigint generated always as identity primary key,
  project_id         bigint not null references projects (id) on delete cascade,
  email              text not null,
  role               text not null,
  token_hash         char(64) not null unique,
  invited_by_user_id bigint not null references users (id) on delete restrict,
  accepted_by_user_id bigint references users (id) on delete set null,
  expires_at         timestamptz not null,
  accepted_at        timestamptz,
  revoked_at         timestamptz,
  created_at         timestamptz not null default now(),
  constraint project_invitations_email_check
    check (email = lower(btrim(email)) and position('@' in email) > 1),
  constraint project_invitations_role_check
    check (role in ('author','approver','publisher')),
  constraint project_invitations_token_hash_check
    check (token_hash ~ '^[0-9a-f]{64}$'),
  constraint project_invitations_ttl_check check (expires_at > created_at),
  constraint project_invitations_resolution_check check (
    not (accepted_at is not null and revoked_at is not null)
    and (accepted_at is null or accepted_by_user_id is not null)
  )
);
create index if not exists project_invitations_project_pending_idx
  on project_invitations (project_id, expires_at, id)
  where accepted_at is null and revoked_at is null;
create index if not exists project_invitations_email_pending_idx
  on project_invitations (email, expires_at, id)
  where accepted_at is null and revoked_at is null;

-- The selected project is server-owned state. A client-provided project id may only
-- be used by the selector service after an active membership check.
create table if not exists user_project_preferences (
  user_id             bigint primary key references users (id) on delete cascade,
  selected_project_id bigint not null references projects (id) on delete restrict,
  updated_at          timestamptz not null default now()
);
create index if not exists user_project_preferences_project_idx
  on user_project_preferences (selected_project_id, user_id);

create table if not exists audit_events (
  id             bigint generated always as identity primary key,
  project_id     bigint not null references projects (id) on delete restrict,
  actor_user_id  bigint references users (id) on delete set null,
  action         varchar(100) not null,
  entity_type    varchar(80) not null,
  entity_id      text,
  before_version bigint,
  after_version  bigint,
  safe_data      jsonb not null default '{}'::jsonb,
  request_id     varchar(128),
  idempotency_key varchar(160),
  created_at     timestamptz not null default now(),
  constraint audit_events_action_check check (length(btrim(action)) between 1 and 100),
  constraint audit_events_entity_type_check check (length(btrim(entity_type)) between 1 and 80),
  constraint audit_events_versions_check check (
    (before_version is null or before_version > 0)
    and (after_version is null or after_version > 0)
  ),
  constraint audit_events_safe_data_check check (jsonb_typeof(safe_data) = 'object')
);
create index if not exists audit_events_project_created_idx
  on audit_events (project_id, created_at desc, id desc);
create unique index if not exists audit_events_project_idempotency_uniq
  on audit_events (project_id, idempotency_key) where idempotency_key is not null;

-- Deterministic legacy backfill: exactly one personal project per user. The unique
-- personal_owner_user_id key also makes concurrent registration/self-healing safe.
insert into projects (
  name, timezone, created_by_user_id, personal_owner_user_id, created_at, updated_at
)
select 'Личный проект', 'UTC', u.id, u.id, now(), now()
  from users u
on conflict (personal_owner_user_id) do nothing;

insert into project_members (project_id, user_id, role, status, joined_at, updated_at)
select p.id, p.personal_owner_user_id, 'owner', 'active', p.created_at, p.created_at
  from projects p
 where p.personal_owner_user_id is not null
on conflict (project_id, user_id) do nothing;

insert into user_project_preferences (user_id, selected_project_id)
select p.personal_owner_user_id, p.id
  from projects p
 where p.personal_owner_user_id is not null
on conflict (user_id) do nothing;

insert into audit_events (
  project_id, actor_user_id, action, entity_type, entity_id,
  after_version, safe_data, idempotency_key, created_at
)
select p.id, p.personal_owner_user_id, 'project.created', 'project', p.id::text,
       p.version, jsonb_build_object('kind', 'personal', 'source', 'legacy_backfill'),
       'bootstrap:personal-project:' || p.id::text, p.created_at
  from projects p
 where p.personal_owner_user_id is not null
on conflict (project_id, idempotency_key) where idempotency_key is not null do nothing;

-- Existing write paths do not yet send project_id. These trigger defaults preserve
-- compatibility while still making every row project-scoped and NOT NULL.
create or replace function aurora_selected_project_for_user(target_user_id bigint)
returns bigint
language sql
stable
as $$
  select coalesce(
    (
      select pref.selected_project_id
        from user_project_preferences pref
        join project_members member
          on member.project_id = pref.selected_project_id
         and member.user_id = pref.user_id
         and member.status = 'active'
        join projects project on project.id = pref.selected_project_id
       where pref.user_id = target_user_id
         and project.is_archived = false
       limit 1
    ),
    (
      select project.id
        from projects project
        join project_members member
          on member.project_id = project.id
         and member.user_id = target_user_id
         and member.status = 'active'
       where project.personal_owner_user_id = target_user_id
         and project.is_archived = false
       limit 1
    )
  )
$$;

create or replace function aurora_assign_user_project()
returns trigger
language plpgsql
as $$
begin
  if new.project_id is null then
    new.project_id := aurora_selected_project_for_user(new.user_id);
  end if;
  if new.project_id is null then
    raise exception 'project_context_missing' using errcode = '23514';
  end if;
  return new;
end
$$;

create or replace function aurora_assign_channel_project()
returns trigger
language plpgsql
as $$
begin
  if new.project_id is null then
    select channel.project_id into new.project_id
      from channels channel
     where channel.id = new.channel_id
       and channel.user_id = new.user_id;
    new.project_id := coalesce(new.project_id, aurora_selected_project_for_user(new.user_id));
  end if;
  if new.project_id is null then
    raise exception 'project_context_missing' using errcode = '23514';
  end if;
  return new;
end
$$;

create or replace function aurora_assign_operation_project()
returns trigger
language plpgsql
as $$
begin
  if new.project_id is null and new.draft_id is not null then
    select draft.project_id into new.project_id
      from drafts draft
     where draft.id = new.draft_id
       and draft.user_id = new.user_id;
  end if;
  if new.project_id is null then
    new.project_id := aurora_selected_project_for_user(new.user_id);
  end if;
  if new.project_id is null then
    raise exception 'project_context_missing' using errcode = '23514';
  end if;
  return new;
end
$$;

alter table channels add column if not exists project_id bigint references projects (id) on delete restrict;
update channels channel
   set project_id = project.id
  from projects project
 where channel.project_id is null
   and project.personal_owner_user_id = channel.user_id;
alter table channels alter column project_id set not null;
create index if not exists channels_project_idx on channels (project_id, id);

alter table drafts add column if not exists project_id bigint references projects (id) on delete restrict;
update drafts draft
   set project_id = project.id
  from projects project
 where draft.project_id is null
   and project.personal_owner_user_id = draft.user_id;
alter table drafts alter column project_id set not null;
create index if not exists drafts_project_updated_idx on drafts (project_id, updated_at desc, id desc);

alter table posts add column if not exists project_id bigint references projects (id) on delete restrict;
update posts post
   set project_id = coalesce(
     (select channel.project_id from channels channel where channel.id = post.channel_id),
     (select project.id from projects project where project.personal_owner_user_id = post.user_id)
   )
 where post.project_id is null;
alter table posts alter column project_id set not null;
create index if not exists posts_project_schedule_idx on posts (project_id, scheduled_at, id);

alter table autopilot_settings add column if not exists project_id bigint references projects (id) on delete restrict;
update autopilot_settings settings
   set project_id = coalesce(
     (select channel.project_id from channels channel where channel.id = settings.channel_id),
     (select project.id from projects project where project.personal_owner_user_id = settings.user_id)
   )
 where settings.project_id is null;
alter table autopilot_settings alter column project_id set not null;
create index if not exists autopilot_settings_project_idx on autopilot_settings (project_id, channel_id);

alter table content_brief add column if not exists project_id bigint references projects (id) on delete restrict;
update content_brief brief
   set project_id = coalesce(
     (select channel.project_id from channels channel where channel.id = brief.channel_id),
     (select project.id from projects project where project.personal_owner_user_id = brief.user_id)
   )
 where brief.project_id is null;
alter table content_brief alter column project_id set not null;
create index if not exists content_brief_project_idx on content_brief (project_id, channel_id);

alter table publication_operations add column if not exists project_id bigint references projects (id) on delete restrict;
update publication_operations operation
   set project_id = coalesce(
     (select draft.project_id from drafts draft where draft.id = operation.draft_id),
     (select project.id from projects project where project.personal_owner_user_id = operation.user_id)
   )
 where operation.project_id is null;
alter table publication_operations alter column project_id set not null;
create index if not exists publication_operations_project_created_idx
  on publication_operations (project_id, created_at desc, id desc);

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'channels_assign_project_before_insert') then
    create trigger channels_assign_project_before_insert
      before insert on channels for each row execute function aurora_assign_user_project();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'drafts_assign_project_before_insert') then
    create trigger drafts_assign_project_before_insert
      before insert on drafts for each row execute function aurora_assign_user_project();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'posts_assign_project_before_insert') then
    create trigger posts_assign_project_before_insert
      before insert on posts for each row execute function aurora_assign_channel_project();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'autopilot_settings_assign_project_before_insert') then
    create trigger autopilot_settings_assign_project_before_insert
      before insert on autopilot_settings for each row execute function aurora_assign_channel_project();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'content_brief_assign_project_before_insert') then
    create trigger content_brief_assign_project_before_insert
      before insert on content_brief for each row execute function aurora_assign_channel_project();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'publication_operations_assign_project_before_insert') then
    create trigger publication_operations_assign_project_before_insert
      before insert on publication_operations for each row execute function aurora_assign_operation_project();
  end if;
end
$$;

commit;
