begin;

-- The Telegram Business inbox becomes the shared, provider-neutral audience
-- assistant inbox. Existing bot rows remain valid; manual and future provider
-- imports do not pretend to have Telegram delivery coordinates.
alter table bot_client_inquiries
  alter column business_connection_id drop not null,
  alter column external_chat_id drop not null,
  alter column external_message_id drop not null,
  add column if not exists request_key varchar(128),
  add column if not exists source_type text not null default 'telegram_business',
  add column if not exists source_label varchar(200),
  add column if not exists source_url text,
  add column if not exists context text,
  add column if not exists author_name varchar(200),
  add column if not exists reply_guidance text,
  add column if not exists tone text,
  add column if not exists risk_level text,
  add column if not exists created_by_user_id bigint references users (id) on delete set null,
  add column if not exists version bigint not null default 1;

alter table bot_client_inquiries
  add constraint bot_client_inquiries_source_type_check
    check (source_type in ('telegram_business','comment','direct_message','support','review','other')),
  add constraint bot_client_inquiries_request_key_check
    check (request_key is null or length(btrim(request_key)) between 16 and 128),
  add constraint bot_client_inquiries_source_label_check
    check (source_label is null or length(btrim(source_label)) between 1 and 200),
  add constraint bot_client_inquiries_context_check
    check (context is null or length(btrim(context)) between 1 and 4000),
  add constraint bot_client_inquiries_author_name_check
    check (author_name is null or length(btrim(author_name)) between 1 and 200),
  add constraint bot_client_inquiries_guidance_check
    check (reply_guidance is null or length(btrim(reply_guidance)) between 1 and 2000),
  add constraint bot_client_inquiries_tone_check
    check (tone is null or tone in ('positive','neutral','negative','aggressive')),
  add constraint bot_client_inquiries_risk_check
    check (risk_level is null or risk_level in ('low','medium','high')),
  add constraint bot_client_inquiries_version_check
    check (version > 0),
  add constraint bot_client_inquiries_delivery_coordinates_check
    check (
      source_type <> 'telegram_business'
      or (business_connection_id is not null and external_chat_id is not null and external_message_id is not null)
    );

create unique index if not exists bot_client_inquiries_project_request_key_uniq
  on bot_client_inquiries (project_id, request_key)
  where request_key is not null;

create index if not exists bot_client_inquiries_project_updated_idx
  on bot_client_inquiries (project_id, updated_at desc, id desc);

commit;
