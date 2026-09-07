begin;

create table if not exists media_storage_policy (
  id smallint primary key check (id = 1),
  user_max_bytes bigint not null check (user_max_bytes > 0),
  project_max_bytes bigint not null check (project_max_bytes > 0),
  global_max_bytes bigint not null check (global_max_bytes > 0),
  updated_at timestamptz not null default now()
);
comment on table media_storage_policy is 'Explicit operator-approved cumulative media limits; no default budget is invented. Missing policy blocks growth, never reads or deletion.';

create table if not exists media_storage_usage (
  scope text not null check (scope in ('global','user','project')),
  scope_id bigint not null check ((scope = 'global' and scope_id = 0) or (scope <> 'global' and scope_id > 0)),
  bytes_used bigint not null check (bytes_used >= 0),
  updated_at timestamptz not null default now(),
  primary key (scope, scope_id)
);

-- Counter initialization and trigger installation form one transaction. Count real
-- postgres payload bytes even when a legacy row understated its declared size.
lock table media_assets in share row exclusive mode;
insert into media_storage_usage(scope,scope_id,bytes_used)
select 'global',0,coalesce(sum(greatest(bytes,coalesce(octet_length(data),0))),0) from media_assets
on conflict (scope,scope_id) do nothing;
insert into media_storage_usage(scope,scope_id,bytes_used)
select 'user',user_id,sum(greatest(bytes,coalesce(octet_length(data),0))) from media_assets group by user_id
on conflict (scope,scope_id) do nothing;
insert into media_storage_usage(scope,scope_id,bytes_used)
select 'project',project_id,sum(greatest(bytes,coalesce(octet_length(data),0))) from media_assets group by project_id
on conflict (scope,scope_id) do nothing;

create or replace function enforce_media_storage_quota() returns trigger language plpgsql as $$
declare
  old_bytes bigint := 0;
  new_bytes bigint := 0;
  old_user bigint;
  new_user bigint;
  old_project bigint;
  new_project bigint;
  policy media_storage_policy%rowtype;
  item record;
  quota bigint;
begin
  if tg_op <> 'INSERT' then
    old_bytes := greatest(old.bytes,coalesce(octet_length(old.data),0));
    old_user := old.user_id;
    old_project := old.project_id;
  end if;
  if tg_op <> 'DELETE' then
    new_bytes := greatest(new.bytes,coalesce(octet_length(new.data),0));
    new_user := new.user_id;
    new_project := new.project_id;
  end if;
  -- A shared policy lock prevents a concurrent configuration change from racing a
  -- charge. All counters are locked in the same global/user/project order.
  if new_bytes > old_bytes or (new_bytes > 0 and (new_user is distinct from old_user or new_project is distinct from old_project)) then
    select * into policy from media_storage_policy where id=1 for share;
    if not found then raise exception using message='media_storage_limits_not_configured',errcode='P0001'; end if;
  end if;
  for item in
    select scope,scope_id,sum(delta)::bigint as delta
      from (values ('global',0::bigint,new_bytes-old_bytes),
                   ('user',old_user,-old_bytes),('user',new_user,new_bytes),
                   ('project',old_project,-old_bytes),('project',new_project,new_bytes)) as changes(scope,scope_id,delta)
     where scope_id is not null
     group by scope,scope_id having sum(delta) <> 0
     order by case scope when 'global' then 0 when 'user' then 1 else 2 end,scope_id
  loop
    quota := case item.scope when 'global' then policy.global_max_bytes when 'user' then policy.user_max_bytes else policy.project_max_bytes end;
    insert into media_storage_usage(scope,scope_id,bytes_used) values(item.scope,item.scope_id,0)
      on conflict(scope,scope_id) do nothing;
    update media_storage_usage set bytes_used=bytes_used+item.delta,updated_at=now()
     where scope=item.scope and scope_id=item.scope_id
       and bytes_used+item.delta >= 0
       and (item.delta <= 0 or bytes_used+item.delta <= quota);
    if not found then
      if item.delta > 0 then raise exception using message='media_storage_quota_exceeded:'||item.scope,errcode='P0001'; end if;
      raise exception using message='media_storage_usage_inconsistent',errcode='P0001';
    end if;
  end loop;
  return null;
end;
$$;

create or replace trigger media_assets_storage_quota
  after insert or update or delete on media_assets
  for each row execute function enforce_media_storage_quota();

commit;
