import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("audience reply assistant migration", () => {
  it("extends the approved Telegram inbox into a provider-neutral assistant inbox", async () => {
    const sql = await readFile(
      resolve(process.cwd(), "db/migrations/20260905_audience_reply_assistant.sql"),
      "utf8",
    );

    expect(sql).toMatch(/^begin;[\s\S]*commit;\s*$/u);
    expect(sql).toContain("alter column business_connection_id drop not null");
    expect(sql).toContain("add column if not exists source_type");
    expect(sql).toContain("bot_client_inquiries_delivery_coordinates_check");
    expect(sql).toContain("bot_client_inquiries_project_request_key_uniq");
    expect(sql).toContain("source_type <> 'telegram_business'");
  });
});
