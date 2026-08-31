import { describe, expect, it, vi } from "vitest";

import { recordAdminObservation } from "./admin-observation-audit";

describe("recordAdminObservation", () => {
  it("persists only allowlisted, scalar, content-free filters", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [] });
    const written = await recordAdminObservation({
      db: { query } as never,
      actorUserId: 7,
      action: "admin.aurora_analytics.read",
      targetType: "section",
      targetId: "studio",
      requestId: "req-1",
      filters: {
        range: "7d", projectId: 42, sectionId: "studio",
        email: "person@example.test", prompt: "private content", nested: { token: "secret" },
      },
    });
    expect(written).toBe(true);
    const values = query.mock.calls[0][1];
    expect(JSON.parse(values[5])).toEqual({ range: "7d", projectId: 42, sectionId: "studio" });
    expect(String(values[5])).not.toContain("person@example.test");
    expect(String(values[5])).not.toContain("private content");
  });

  it("refuses malformed actors and targets without querying", async () => {
    const query = vi.fn();
    await expect(recordAdminObservation({
      db: { query } as never,
      actorUserId: 0,
      action: "admin.system.read",
      targetType: "runtime",
    })).resolves.toBe(false);
    await expect(recordAdminObservation({
      db: { query } as never,
      actorUserId: 7,
      action: "admin.system.read",
      targetType: "component",
      targetId: "../unsafe",
    })).resolves.toBe(false);
    expect(query).not.toHaveBeenCalled();
  });
});
