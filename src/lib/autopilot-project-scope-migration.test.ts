import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("autopilot project-scope migration policy", () => {
  it("is additive, transactional and mirrors the bootstrap schema", async () => {
    const sql = await readFile(
      resolve(process.cwd(), "db/migrations/20260815_autopilot_project_scope.sql"),
      "utf8",
    );
    const repairs = await readFile(
      resolve(process.cwd(), "db/migrations/20260827_post_apply_migration_repairs.sql"),
      "utf8",
    );
    const bootstrap = await readFile(resolve(process.cwd(), "db/schema.sql"), "utf8");

    expect(sql).toMatch(/^begin;[\s\S]*commit;\s*$/u);
    expect(sql).not.toMatch(/\bdrop\s+(?:table|column)\b|\btruncate\b|\bdelete\s+from\b/iu);
    expect(sql).toContain("alter table autopilot_approval_operations");
    expect(sql).toContain("alter table autopilot_approval_previews");
    expect(sql).toContain("alter table autopilot_schedule_outbox");
    expect(repairs).toContain("alter table monthly_campaign_regeneration_targets");
    expect(sql.match(/alter column project_id set not null/g)).toHaveLength(3);
    expect(repairs).toContain("alter column item_regeneration_version set not null");

    for (const invariant of [
      "autopilot_approval_operations_project_actor_key_uniq",
      "autopilot_schedule_outbox_project_pending_idx",
      "autopilot_approval_previews_operation_project_fk",
      "monthly_campaign_regeneration_targets",
      "autopilot_plan_approval_operation_project_fk",
      "publication_review_tasks_version_check",
    ]) {
      expect(bootstrap).toContain(invariant);
    }
  });

  it("enforces same-project channels, plans, operations, posts and idempotency", async () => {
    const sql = await readFile(
      resolve(process.cwd(), "db/migrations/20260815_autopilot_project_scope.sql"),
      "utf8",
    );
    const repairs = await readFile(
      resolve(process.cwd(), "db/migrations/20260827_post_apply_migration_repairs.sql"),
      "utf8",
    );

    expect(sql).toContain("on autopilot_settings (project_id, channel_id)");
    expect(sql).toContain("on content_brief (project_id, channel_id)");
    expect(sql).toContain("on autopilot_approval_operations (project_id, user_id, idempotency_key)");
    expect(sql).toContain("foreign key (channel_id, project_id) references channels (id, project_id)");
    expect(sql).toContain("foreign key (plan_id, project_id) references autopilot_plan (id, project_id)");
    expect(sql).toContain("references autopilot_approval_operations (id, project_id)");
    expect(repairs).toContain("foreign key (approval_operation_id, project_id)");
    expect(sql).toContain("foreign key (post_id, project_id) references posts (id, project_id)");
  });
});
