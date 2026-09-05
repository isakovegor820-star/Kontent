-- Project-local pagination fence. One increment per affected project per SQL statement,
-- including bulk imports/status updates; unrelated projects do not invalidate the cursor.
BEGIN;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS calendar_version bigint NOT NULL DEFAULT 1;

CREATE OR REPLACE FUNCTION advance_project_calendar_version() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  project_ids bigint[];
  target_project bigint;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT array_agg(project_id ORDER BY project_id) INTO project_ids
      FROM (SELECT DISTINCT project_id FROM new_calendar_posts WHERE project_id IS NOT NULL) changed;
  ELSIF TG_OP = 'DELETE' THEN
    SELECT array_agg(project_id ORDER BY project_id) INTO project_ids
      FROM (SELECT DISTINCT project_id FROM old_calendar_posts WHERE project_id IS NOT NULL) changed;
  ELSE
    SELECT array_agg(project_id ORDER BY project_id) INTO project_ids
      FROM (SELECT project_id FROM old_calendar_posts WHERE project_id IS NOT NULL
            UNION SELECT project_id FROM new_calendar_posts WHERE project_id IS NOT NULL) changed;
  END IF;
  FOREACH target_project IN ARRAY coalesce(project_ids, ARRAY[]::bigint[]) LOOP
    UPDATE projects SET calendar_version = calendar_version + 1 WHERE id = target_project;
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE TRIGGER posts_calendar_insert
  AFTER INSERT ON posts REFERENCING NEW TABLE AS new_calendar_posts
  FOR EACH STATEMENT EXECUTE FUNCTION advance_project_calendar_version();
CREATE OR REPLACE TRIGGER posts_calendar_update
  AFTER UPDATE ON posts REFERENCING OLD TABLE AS old_calendar_posts NEW TABLE AS new_calendar_posts
  FOR EACH STATEMENT EXECUTE FUNCTION advance_project_calendar_version();
CREATE OR REPLACE TRIGGER posts_calendar_delete
  AFTER DELETE ON posts REFERENCING OLD TABLE AS old_calendar_posts
  FOR EACH STATEMENT EXECUTE FUNCTION advance_project_calendar_version();
COMMIT;
