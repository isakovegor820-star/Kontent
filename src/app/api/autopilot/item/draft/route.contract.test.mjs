import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const source = await readFile(new URL("./route.ts", import.meta.url), "utf8");

describe("Autopilot full-editor handoff contract", () => {
  it("binds the editor draft to the exact project, channel, plan and revision", () => {
    expect(source).toContain("hasTrustedMutationOrigin(req)");
    expect(source).toContain('requireSelectedProjectPermission(pool, user.id, "content.edit")');
    expect(source).toContain("revision = $4");
    expect(source).toContain("for update");
    expect(source).toContain("project_id = $2 and channel_id = $3");
  });

  it("preserves the planned instant and creates a publishable Composer draft", () => {
    expect(source).toContain("localScheduleFieldsForInstant(item.scheduledAt");
    expect(source).toContain("'autopilot', 'publishable'");
    expect(source).toContain("insert into draft_destinations");
    expect(source).toContain("item.draftId = draftId");
    expect(source).toContain("revision = revision + 1");
  });
});
