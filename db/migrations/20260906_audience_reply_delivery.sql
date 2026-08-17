begin;

-- A linked Telegram discussion group is the durable project boundary for both
-- post comments and ordinary messages sent in that group.
alter table channels
  add column if not exists tg_discussion_chat_id bigint;

create unique index if not exists channels_tg_discussion_chat_active_uniq
  on channels (tg_discussion_chat_id)
  where network = 'tg' and is_active = true and tg_discussion_chat_id is not null;

-- Delivery is claimed before the external provider call. If the network outcome
-- is unknown, the request remains non-repeatable until a human verifies Telegram.
alter table bot_client_inquiries
  add column if not exists delivery_request_key varchar(128),
  add column if not exists provider_started_at timestamptz,
  add column if not exists sent_external_message_id bigint,
  add column if not exists delivery_error_code varchar(80);

alter table bot_client_inquiries
  add constraint bot_client_inquiries_delivery_request_key_check
    check (delivery_request_key is null or length(btrim(delivery_request_key)) between 16 and 128),
  add constraint bot_client_inquiries_delivery_error_code_check
    check (delivery_error_code is null or length(btrim(delivery_error_code)) between 1 and 80);

create unique index if not exists bot_client_inquiries_project_delivery_request_uniq
  on bot_client_inquiries (project_id, delivery_request_key)
  where delivery_request_key is not null;

commit;
