import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const schema = await readFile(new URL("../db/schema.sql", import.meta.url), "utf8");
const channelLibraryMigration = await readFile(
  new URL("../db/migrations/20260801_channel_scoped_library.sql", import.meta.url),
  "utf8",
);
const autopilotOutboxMigration = await readFile(
  new URL("../db/migrations/20260802_autopilot_schedule_outbox.sql", import.meta.url),
  "utf8",
);
const draftReviewMigration = await readFile(
  new URL("../db/migrations/20260802_draft_review_safety.sql", import.meta.url),
  "utf8",
);
const mediaSafetyMigration = await readFile(
  new URL("../db/migrations/20260805_media_generation_safety.sql", import.meta.url),
  "utf8",
);
const executable = schema
  .replace(/\/\*[\s\S]*?\*\//gu, " ")
  .replace(/--[^\r\n]*/gu, " ")
  .replace(/\s+/gu, " ")
  .toLowerCase();

function outboxDefinition(sql) {
  const match = sql.match(
    /create table if not exists autopilot_schedule_outbox\s*\(([\s\S]*?)\n\);/iu,
  );
  return match?.[1].replace(/--[^\r\n]*/gu, " ").replace(/\s+/gu, " ").trim() ?? null;
}

describe("fresh database bootstrap snapshot", () => {
  it("contains every production safety object introduced by migrations", () => {
    for (const fragment of [
      "onboarding_completed_at",
      "ai_post_settings",
      "password_reset_tokens",
      "ai_usage_reservation_fields_check",
      "autopilot_approval_operations",
      "external_message_id",
      "verification_state",
      "posts_user_idempotency_key_uniq",
      "create table if not exists drafts",
      "create table if not exists draft_destinations",
      "schema_migrations",
    ]) {
      expect(executable, fragment).toContain(fragment);
    }
  });

  it("does not silently destroy legacy data when used for a fresh bootstrap", () => {
    expect(executable).not.toMatch(/\bdrop\s+table\b/u);
    expect(executable).not.toMatch(/\bdrop\s+column\b/u);
    expect(executable).not.toMatch(/\btruncate(?:\s+table)?\b/u);
    expect(executable).not.toMatch(/\bdelete\s+from\b/u);
  });

  it("does not guess a brand for legacy account-wide library records", () => {
    for (const sql of [schema, channelLibraryMigration]) {
      expect(sql).not.toMatch(/set\s+channel_id\s*=\s*\([\s\S]*order\s+by\s+channel\.id\s+limit\s+1/iu);
    }
    expect(channelLibraryMigration).toContain(
      "hashtag_sets_unassigned_name_uniq",
    );
  });

  it("keeps the Autopilot lease/outbox bootstrap definition in migration parity", () => {
    expect(outboxDefinition(schema)).not.toBeNull();
    expect(outboxDefinition(schema)).toBe(outboxDefinition(autopilotOutboxMigration));
    for (const sql of [schema, autopilotOutboxMigration]) {
      for (const fragment of [
        "approval_operation_id",
        "approval_started_at",
        "approval_heartbeat_at",
        "unique (plan_id, item_index)",
        "post_id       bigint      not null unique",
        "autopilot_schedule_outbox_pending_idx",
        "where status = 'pending'",
      ]) {
        expect(sql, fragment).toContain(fragment);
      }
    }
  });

  it("keeps versioned AI draft review state in migration parity", () => {
    for (const sql of [schema, draftReviewMigration]) {
      for (const fragment of [
        "review_policy_version",
        "check (review_policy_version = 1)",
        "ai_validation",
        "human_reviewed_version",
        "human_reviewed_at",
      ]) {
        expect(sql, fragment).toContain(fragment);
      }
    }
  });

  it("keeps the media correlation, prompt policy and queue handoff in migration parity", () => {
    for (const sql of [schema, mediaSafetyMigration]) {
      for (const fragment of [
        "request_id",
        "provider_request_key",
        "prompt_policy_version",
        "prompt_context",
        "queue_confirmed_at",
        "provider_started_at",
        "media_generations_request_id_uniq",
        "media_generations_provider_request_key_uniq",
      ]) {
        expect(sql, fragment).toContain(fragment);
      }
    }
  });
});
