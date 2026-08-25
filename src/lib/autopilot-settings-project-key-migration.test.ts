import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("autopilot settings project key migration", () => {
  it("promotes the project key while preserving the previous release conflict arbiter", async () => {
    const migration = await readFile(
      resolve(process.cwd(), "db/migrations/20260928_autopilot_settings_project_key.sql"),
      "utf8",
    );
    const bootstrap = await readFile(resolve(process.cwd(), "db/schema.sql"), "utf8");

    expect(migration).toMatch(/^begin;[\s\S]*commit;\s*$/u);
    expect(migration).toContain("autopilot_settings_project_key_missing");
    expect(migration).toContain("autopilot_settings_project_key_duplicate");
    expect(migration).toContain("drop constraint if exists autopilot_settings_pkey");
    expect(migration).toContain("primary key using index autopilot_settings_project_channel_uniq");
    expect(migration).toContain("autopilot_settings_user_channel_uniq");
    expect(migration).not.toMatch(/\b(?:delete\s+from|truncate|drop\s+(?:table|column))\b/iu);

    expect(bootstrap).toContain("autopilot_settings_project_key_duplicate");
    expect(bootstrap).toContain("PRIMARY KEY (project_id, channel_id)");
    expect(bootstrap).toContain("autopilot_settings_user_channel_uniq");
  });
});
