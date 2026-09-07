begin;
-- An address supplied at registration is not proof of mailbox ownership.
-- No historical address is automatically promoted; ID-based admin grants remain valid.
alter table users add column if not exists verified_email text;
commit;
