import { describe, expect, it } from "vitest";

import { COMPETITOR_MECHANIC_ACTION_LABEL } from "./bot-copy.mjs";

describe("Telegram competitor action copy", () => {
  it("uses the platform-neutral action label", () => {
    expect(COMPETITOR_MECHANIC_ACTION_LABEL).toBe("Создать пост по механике");
    expect(COMPETITOR_MECHANIC_ACTION_LABEL).not.toContain("Сними это");
  });
});
