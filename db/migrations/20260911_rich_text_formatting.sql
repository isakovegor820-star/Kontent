begin;

-- Inline formatting is stored separately from the plain publication text so AI,
-- search, analytics, previews and providers without rich text keep a clean body.
alter table drafts
  add column if not exists formatting jsonb not null default '[]'::jsonb;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'drafts_formatting_array_check'
  ) then
    alter table drafts add constraint drafts_formatting_array_check
      check (jsonb_typeof(formatting) = 'array');
  end if;
end
$$;

commit;
