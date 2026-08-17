import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("audience reply delivery migration", () => {
  it("persists discussion bindings and fail-closed Telegram delivery state", async () => {
    const sql = await readFile(
      resolve(process.cwd(), "db/migrations/20260906_audience_reply_delivery.sql"),
      "utf8",
    );
    expect(sql).toContain("tg_discussion_chat_id");
    expect(sql).toContain("delivery_request_key");
    expect(sql).toContain("provider_started_at");
    expect(sql).toContain("delivery_error_code");
    expect(sql).toContain("bot_client_inquiries_project_delivery_request_uniq");
  });
});
