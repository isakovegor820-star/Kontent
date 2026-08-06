-- Legacy bootstrap snapshots accepted by migrate.mjs predate competitor suggestions.
-- Create the complete additive baseline before the 20260805 column migrations run.

begin;

create table if not exists competitor_suggestions (
  id             bigint generated always as identity primary key,
  user_id        bigint not null references users (id) on delete cascade,
  channel_id     bigint references channels (id) on delete cascade,
  handle         text not null,
  title          text,
  description    text,
  subscribers    int,
  posts          int,
  last_post_at   timestamptz,
  posts_per_week numeric(6,1),
  mentioned_by   int not null default 1,
  sources        text[] not null default '{}',
  on_topic       boolean,
  status         text not null default 'new'
                 check (status in ('new', 'added', 'dismissed')),
  found_at       timestamptz not null default now()
);

-- A partially provisioned database may already have the original table but not the
-- channel/activity fields. Every addition remains safe on the monolithic fresh schema.
alter table competitor_suggestions add column if not exists channel_id bigint;
alter table competitor_suggestions add column if not exists title text;
alter table competitor_suggestions add column if not exists description text;
alter table competitor_suggestions add column if not exists subscribers int;
alter table competitor_suggestions add column if not exists posts int;
alter table competitor_suggestions add column if not exists last_post_at timestamptz;
alter table competitor_suggestions add column if not exists posts_per_week numeric(6,1);
alter table competitor_suggestions add column if not exists mentioned_by int not null default 1;
alter table competitor_suggestions add column if not exists sources text[] not null default '{}';
alter table competitor_suggestions add column if not exists on_topic boolean;
alter table competitor_suggestions add column if not exists status text not null default 'new';
alter table competitor_suggestions add column if not exists found_at timestamptz not null default now();

update competitor_suggestions suggestion
   set channel_id = (
     select min(channel.id)
       from channels channel
      where channel.user_id = suggestion.user_id
        and channel.network = 'tg'
   )
 where suggestion.channel_id is null;

do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conrelid = 'competitor_suggestions'::regclass
       and conname = 'competitor_suggestions_channel_id_fkey'
  ) then
    alter table competitor_suggestions
      add constraint competitor_suggestions_channel_id_fkey
      foreign key (channel_id) references channels (id) on delete cascade;
  end if;

  if not exists (
    select 1
      from pg_constraint
     where conrelid = 'competitor_suggestions'::regclass
       and conname = 'competitor_suggestions_status_check'
  ) then
    alter table competitor_suggestions
      add constraint competitor_suggestions_status_check
      check (status in ('new', 'added', 'dismissed'));
  end if;

  if not exists (select 1 from competitor_suggestions where channel_id is null) then
    alter table competitor_suggestions alter column channel_id set not null;
  end if;
end
$$;

create index if not exists competitor_suggestions_user_idx
  on competitor_suggestions (user_id, status, mentioned_by desc);
create unique index if not exists competitor_suggestions_channel_handle_key
  on competitor_suggestions (channel_id, handle);

commit;
