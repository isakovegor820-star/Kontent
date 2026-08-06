import { describe, expect, it, vi } from "vitest";

import { convertMatchingLeadAfterRegistration } from "./users";

describe("post-commit lead conversion", () => {
  it("does not fail registration when lead storage is unavailable", async () => {
    const query = vi.fn().mockRejectedValue(Object.assign(new Error("db unavailable"), { code: "08006" }));
    await expect(convertMatchingLeadAfterRegistration(
      ["user@example.test"],
      "User",
      { query: { query } as never, notify: vi.fn() },
    )).resolves.toEqual({ converted: false, notified: false });
  });

  it("keeps a converted lead committed when notification fails", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [{ contact: "user@example.test" }] });
    await expect(convertMatchingLeadAfterRegistration(
      ["user@example.test"],
      "User",
      { query: { query } as never, notify: vi.fn().mockRejectedValue(new Error("notify unavailable")) },
    )).resolves.toEqual({ converted: true, notified: false });
  });
});
