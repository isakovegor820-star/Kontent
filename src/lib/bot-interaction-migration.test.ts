import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  new URL("../../db/migrations/20260913_bot_interaction_observability.sql", import.meta.url),
  "utf8",
);

describe("bot interaction observability migration", () => {
  it("stores idempotent metadata without message bodies or Telegram identities", () => {
    expect(sql).toContain("create table if not exists bot_interaction_events");
    expect(sql).toContain("telegram_update_id  bigint not null unique");
    expect(sql).toContain("interaction_type");
    expect(sql).toContain("action");
    expect(sql).not.toMatch(/message_text|callback_data|telegram_user_id|chat_id|token_hash/iu);
  });

  it("indexes recent, user and project views", () => {
    expect(sql).toContain("bot_interaction_events_created_idx");
    expect(sql).toContain("bot_interaction_events_user_idx");
    expect(sql).toContain("bot_interaction_events_project_idx");
  });
});
