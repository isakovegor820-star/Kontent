begin;

-- A reusable short link is a campaign asset, while every published destination needs
-- its own opaque redirect identity. This placement makes post-level attribution exact
-- without exposing a post, channel or project identifier in the public URL.
create table if not exists short_link_placements (
  id                       bigint generated always as identity primary key,
  project_id               bigint not null references projects (id) on delete cascade,
  short_link_id            bigint not null references short_links (id) on delete cascade,
  -- Publications can be removed from the workspace while their public Telegram
  -- copies still contain this redirect. Keep the placement usable and detach only
  -- the deleted internal owner instead of breaking the public URL or the delete.
  publication_operation_id bigint,
  post_id                  bigint,
  slug                     varchar(64) not null unique,
  created_at               timestamptz not null default now(),
  constraint short_link_placements_slug_check check (slug ~ '^[A-Za-z0-9_-]{20,64}$'),
  constraint short_link_placements_link_project_fk
    foreign key (short_link_id, project_id)
    references short_links (id, project_id) on delete cascade,
  constraint short_link_placements_operation_project_fk
    foreign key (publication_operation_id, project_id)
    references publication_operations (id, project_id)
    on delete set null (publication_operation_id),
  constraint short_link_placements_post_project_fk
    foreign key (post_id, project_id)
    references posts (id, project_id)
    on delete set null (post_id),
  unique (post_id),
  unique (publication_operation_id, post_id),
  unique (id, short_link_id, project_id)
);
create index if not exists short_link_placements_link_idx
  on short_link_placements (short_link_id, created_at desc, id desc);
create index if not exists short_link_placements_project_idx
  on short_link_placements (project_id, created_at desc, id desc);

alter table short_link_clicks
  add column if not exists placement_id bigint;
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'short_link_clicks_placement_link_project_fk'
  ) then
    alter table short_link_clicks
      add constraint short_link_clicks_placement_link_project_fk
      foreign key (placement_id, short_link_id, project_id)
      references short_link_placements (id, short_link_id, project_id)
      on delete set null (placement_id);
  end if;
end
$$;
create index if not exists short_link_clicks_placement_time_idx
  on short_link_clicks (placement_id, occurred_at desc, id)
  where placement_id is not null;

alter table publication_tracking_snapshots
  add column if not exists short_link_placement_id bigint;
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'publication_tracking_placement_link_project_fk'
  ) then
    alter table publication_tracking_snapshots
      add constraint publication_tracking_placement_link_project_fk
      foreign key (short_link_placement_id, short_link_id, project_id)
      references short_link_placements (id, short_link_id, project_id)
      on delete set null (short_link_placement_id);
  end if;
end
$$;
create unique index if not exists publication_tracking_short_placement_uniq
  on publication_tracking_snapshots (short_link_placement_id)
  where short_link_placement_id is not null;

commit;
