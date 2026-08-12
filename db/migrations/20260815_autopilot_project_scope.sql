begin;

-- Autopilot is shared project state. `user_id` records the actor/creator, but it is
-- never the tenant boundary. These composite keys make a cross-project relation
-- impossible even if a future application query forgets one predicate.
create unique index if not exists channels_id_project_uniq
  on channels (id, project_id);
create unique index if not exists autopilot_settings_project_channel_uniq
  on autopilot_settings (project_id, channel_id);
create unique index if not exists content_brief_project_channel_uniq
  on content_brief (project_id, channel_id);

alter table autopilot_approval_operations
  add column if not exists project_id bigint references projects (id) on delete restrict;
update autopilot_approval_operations operation
   set project_id = coalesce(
     (select plan.project_id from autopilot_plan plan where plan.id = operation.plan_id),
     (select channel.project_id from channels channel where channel.id = operation.channel_id)
   )
 where operation.project_id is null;
alter table autopilot_approval_operations alter column project_id set not null;
create unique index if not exists autopilot_approval_operations_id_project_uniq
  on autopilot_approval_operations (id, project_id);
create unique index if not exists autopilot_approval_operations_project_actor_key_uniq
  on autopilot_approval_operations (project_id, user_id, idempotency_key);
create index if not exists autopilot_approval_operations_project_plan_idx
  on autopilot_approval_operations (project_id, plan_id, created_at desc, id desc);

alter table autopilot_approval_previews
  add column if not exists project_id bigint references projects (id) on delete restrict;
update autopilot_approval_previews preview
   set project_id = coalesce(
     (select plan.project_id from autopilot_plan plan where plan.id = preview.plan_id),
     (select operation.project_id
        from autopilot_approval_operations operation
       where operation.id = preview.operation_id),
     (select channel.project_id from channels channel where channel.id = preview.channel_id)
   )
 where preview.project_id is null;
alter table autopilot_approval_previews alter column project_id set not null;

alter table autopilot_schedule_outbox
  add column if not exists project_id bigint references projects (id) on delete restrict;
update autopilot_schedule_outbox outbox
   set project_id = coalesce(
     (select plan.project_id from autopilot_plan plan where plan.id = outbox.plan_id),
     (select post.project_id from posts post where post.id = outbox.post_id),
     (select channel.project_id from channels channel where channel.id = outbox.channel_id)
   )
 where outbox.project_id is null;
alter table autopilot_schedule_outbox alter column project_id set not null;
create index if not exists autopilot_schedule_outbox_project_pending_idx
  on autopilot_schedule_outbox (project_id, updated_at, id)
  where status = 'pending';
create index if not exists monthly_campaign_regeneration_outbox_redelivery_idx
  on monthly_campaign_regeneration_outbox (updated_at, id)
  where status = 'enqueued';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'autopilot_settings_channel_project_fk') then
    alter table autopilot_settings add constraint autopilot_settings_channel_project_fk
      foreign key (channel_id, project_id) references channels (id, project_id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'content_brief_channel_project_fk') then
    alter table content_brief add constraint content_brief_channel_project_fk
      foreign key (channel_id, project_id) references channels (id, project_id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'autopilot_plan_channel_project_fk') then
    alter table autopilot_plan add constraint autopilot_plan_channel_project_fk
      foreign key (channel_id, project_id) references channels (id, project_id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'posts_channel_project_fk') then
    alter table posts add constraint posts_channel_project_fk
      foreign key (channel_id, project_id) references channels (id, project_id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'autopilot_approval_operations_channel_project_fk') then
    alter table autopilot_approval_operations add constraint autopilot_approval_operations_channel_project_fk
      foreign key (channel_id, project_id) references channels (id, project_id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'autopilot_approval_operations_plan_project_fk') then
    alter table autopilot_approval_operations add constraint autopilot_approval_operations_plan_project_fk
      foreign key (plan_id, project_id) references autopilot_plan (id, project_id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'autopilot_approval_previews_channel_project_fk') then
    alter table autopilot_approval_previews add constraint autopilot_approval_previews_channel_project_fk
      foreign key (channel_id, project_id) references channels (id, project_id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'autopilot_approval_previews_plan_project_fk') then
    alter table autopilot_approval_previews add constraint autopilot_approval_previews_plan_project_fk
      foreign key (plan_id, project_id) references autopilot_plan (id, project_id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'autopilot_approval_previews_operation_project_fk') then
    alter table autopilot_approval_previews add constraint autopilot_approval_previews_operation_project_fk
      foreign key (operation_id, project_id)
      references autopilot_approval_operations (id, project_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'autopilot_schedule_outbox_plan_project_fk') then
    alter table autopilot_schedule_outbox add constraint autopilot_schedule_outbox_plan_project_fk
      foreign key (plan_id, project_id) references autopilot_plan (id, project_id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'autopilot_schedule_outbox_channel_project_fk') then
    alter table autopilot_schedule_outbox add constraint autopilot_schedule_outbox_channel_project_fk
      foreign key (channel_id, project_id) references channels (id, project_id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'autopilot_schedule_outbox_operation_project_fk') then
    alter table autopilot_schedule_outbox add constraint autopilot_schedule_outbox_operation_project_fk
      foreign key (operation_id, project_id)
      references autopilot_approval_operations (id, project_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'autopilot_schedule_outbox_post_project_fk') then
    alter table autopilot_schedule_outbox add constraint autopilot_schedule_outbox_post_project_fk
      foreign key (post_id, project_id) references posts (id, project_id) on delete cascade;
  end if;
end
$$;

commit;
