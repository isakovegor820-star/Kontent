begin;

alter table publication_parts add column if not exists payload_html text;
alter table publication_parts add column if not exists payload_hash char(64);
alter table publication_parts add column if not exists entity_length integer;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'publication_parts'::regclass
       and conname = 'publication_parts_payload_hash_check'
  ) then
    alter table publication_parts add constraint publication_parts_payload_hash_check
      check (payload_hash is null or payload_hash ~ '^[0-9a-f]{64}$');
  end if;
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'publication_parts'::regclass
       and conname = 'publication_parts_entity_length_check'
  ) then
    alter table publication_parts add constraint publication_parts_entity_length_check
      check (
        entity_length is null
        or (
          entity_length >= 0
          and entity_length <= case when part_type = 'media_caption' then 1024 else 4096 end
        )
      );
  end if;
end $$;

commit;
