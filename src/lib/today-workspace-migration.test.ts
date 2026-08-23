import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  new URL("../../db/migrations/20260927_today_workspace.sql", import.meta.url),
  "utf8",
);

describe("Today workspace provisioning migration", () => {
  it("is additive, transactional and project/channel scoped", () => {
    expect(sql).toMatch(/^begin;[\s\S]*commit;\s*$/u);
    expect(sql).not.toMatch(/\btruncate\b|\bdelete\s+from\b|\bdrop\s+(?:table|column)\b/iu);
    expect(sql).toContain("today_source_refreshes_channel_project_fk");
    expect(sql).toContain("foreign key (channel_id, project_id) references channels (id, project_id)");
  });

  it("backfills active channels while preserving an explicit administrator rollback", () => {
    expect(sql).toContain("channel.is_active = true");
    expect(sql).toContain("channel.status = 'active'");
    expect(sql).toContain("channel_feature_flags.enabled_by_user_id is null");
    expect(sql).toContain("channel_feature_flags.enabled_at is null");
  });

  it("provisions new active channels once and never re-enables an existing row", () => {
    expect(sql).toContain("aurora_provision_today_feature");
    expect(sql).toContain("after insert or update of is_active, status, project_id on channels");
    expect(sql).toContain("on conflict (project_id, channel_id, feature_key) do nothing");
  });

  it("keeps the last successful source timestamp when a later refresh fails", () => {
    expect(sql).toContain("last_success_at timestamptz");
    expect(sql).toContain("source in ('reviews', 'opportunities', 'results')");
    expect(sql).toContain("last_attempt_state in ('success', 'error')");
  });
});
