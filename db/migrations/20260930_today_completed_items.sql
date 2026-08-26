begin;

alter table today_item_states
  add column if not exists item_snapshot jsonb;

alter table today_item_states
  add constraint today_item_states_snapshot_check check (
    item_snapshot is null or (
      state = 'done'
      and jsonb_typeof(item_snapshot) = 'object'
    )
  );

create index if not exists today_item_states_user_done_today_idx
  on today_item_states (user_id, project_id, channel_id, updated_at desc)
  where state = 'done';

commit;
