begin;
-- Historical delivery receipts remain unchanged. A pending legacy operation without
-- its actual publisher cannot infer authority from the author or approver.
alter table site_article_publications
  add column if not exists requested_by_user_id bigint
    references users (id) on delete restrict;
commit;
