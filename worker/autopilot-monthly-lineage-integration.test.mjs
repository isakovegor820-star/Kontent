import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const source = await readFile(new URL("../worker.mjs", import.meta.url), "utf8");

describe("Autopilot replacement preserves monthly campaign lineage", () => {
  it("keeps linked plans/posts and removes only jobs for posts actually deleted", () => {
    expect(source).toContain("monthly_item.post_id = post.id");
    expect(source).toContain("monthly_item.weekly_autopilot_plan_id = plan.id");
    expect(source).toContain("set status = 'done', revision = revision + 1");
    expect(source).toContain("removedPreviousPostIds = removedPosts.rows.map");
    expect(source).toContain("await removePublishJobs(removedPreviousPostIds)");
  });

  it("bootstraps immutable editorial evidence before exposing every monthly draft", () => {
    expect(source).toContain("ensureDraftEditorialBootstrap(tx, {");
    expect(source.indexOf("ensureDraftEditorialBootstrap(tx, {")).toBeLessThan(
      source.indexOf("item.draftId = draftId"),
    );
  });
});
