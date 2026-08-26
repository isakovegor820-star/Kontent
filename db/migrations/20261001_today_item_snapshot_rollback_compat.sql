begin;

-- The previous release does not know about item_snapshot. When it changes a completed
-- item to another state, its legacy UPSERT leaves the snapshot untouched and would fail
-- the new done-only constraint. Normalize that old write at the database boundary so an
-- application rollback remains operational without weakening the stored invariant.
create or replace function aurora_clear_inactive_today_item_snapshot()
returns trigger language plpgsql as $$
begin
  if new.state <> 'done' then
    new.item_snapshot := null;
  end if;
  return new;
end
$$;

drop trigger if exists today_item_states_clear_inactive_snapshot_before_write on today_item_states;
create trigger today_item_states_clear_inactive_snapshot_before_write
  before insert or update of state, item_snapshot on today_item_states
  for each row execute function aurora_clear_inactive_today_item_snapshot();

commit;
