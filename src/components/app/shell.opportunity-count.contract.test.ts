import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./shell.tsx", import.meta.url), "utf8");

describe("opportunity navigation count", () => {
  it("waits for the current project's active channel before loading the badge", () => {
    expect(source).toContain("function useOpportunityUnreadCount(userId: number | null, channelId: number | null)");
    expect(source).toContain("if (userId == null || channelId == null)");
    expect(source).toContain("`/api/opportunities?channel=${channelId}&surface=market&view=active`");
    expect(source).toContain("realReady");
  });

  it("does not reuse the previous project's channel from the project-change event", () => {
    expect(source).toContain('window.addEventListener("aurora:project-changed", handleProjectChange)');
    expect(source).not.toContain('setCount(0);\n      void refresh();');
  });
});
