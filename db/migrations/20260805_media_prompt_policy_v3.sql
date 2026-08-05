-- Preserve historical generations while allowing the current versioned visual brief builder.

begin;

alter table media_generations
  drop constraint if exists media_generations_prompt_policy_version_check;
alter table media_generations
  add constraint media_generations_prompt_policy_version_check
  check (prompt_policy_version between 1 and 3);

commit;
