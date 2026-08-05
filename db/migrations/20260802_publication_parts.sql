begin;

create table if not exists publication_parts (
  id                    bigint generated always as identity primary key,
  post_id               bigint not null references posts (id) on delete cascade,
  part_index            integer not null check (part_index >= 0),
  part_type             text not null check (part_type in ('text','media','media_caption')),
  external_message_id   text,
  send_status           text not null default 'pending'
                        check (send_status in ('pending','sending','sent','failed','unknown')),
  verification_state    text not null default 'unverified'
                        check (verification_state in ('unverified','verified','missing','unverifiable')),
  attempts              integer not null default 0 check (attempts >= 0),
  last_error_code       text,
  last_verified_at      timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (post_id, part_index)
);
create index if not exists publication_parts_external_idx
  on publication_parts (post_id, external_message_id)
  where external_message_id is not null;

commit;
