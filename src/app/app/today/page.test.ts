import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("Today page resilience and interface contract", () => {
  const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");

  it("refreshes on project changes and sends the selected channel to the API", () => {
    expect(source).toContain('window.addEventListener("aurora:project-changed"');
    expect(source).toContain('`/api/today${query}`');
    expect(source).toContain('params.set("channel", String(channelId))');
    expect(source).toContain("activeController.current?.abort()");
  });

  it("keeps action failures local and offers an accessible undo", () => {
    expect(source).toContain("setItemErrors");
    expect(source).toContain('aria-live="polite"');
    expect(source).toContain('state: "active" | "snoozed"');
    expect(source).toContain("Вернуть");
  });

  it("does not expose internal rollout or ranking identifiers", () => {
    expect(source).not.toContain("Release 1");
    expect(source).not.toContain("rankingVersion");
    expect(source).not.toContain("today-rank-v1");
  });
});
