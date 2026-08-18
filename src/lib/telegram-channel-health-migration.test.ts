import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../../db/migrations/20260915_telegram_channel_health.sql", import.meta.url),
  "utf8",
);

describe("Telegram channel health migration", () => {
  it("quarantines ghost active channels and prevents the state from recurring", () => {
    expect(migration).toContain("status = 'needs_reconnect'");
    expect(migration).toContain("telegram_chat_id_missing");
    expect(migration).toContain("channels_active_telegram_chat_check");
    expect(migration).toContain("tg_chat_id is not null");
    expect(migration).not.toMatch(/drop\s+table|truncate/iu);
  });
});
