begin;

-- Media generation is an AI surface too. Bind each durable generation to the same
-- account-wide usage reservation used by text, Autopilot and bot flows.
alter table media_generations
  add column if not exists request_key varchar(96);
alter table media_generations
  add column if not exists ai_usage_reservation_id bigint references ai_usage (id) on delete set null;

create unique index if not exists media_generations_user_request_key_uniq
  on media_generations (user_id, request_key)
  where request_key is not null;

commit;
