import { describe, expect, it, vi } from "vitest";

import { beginProviderCall, claimPublicationLease } from "./publication-lease.mjs";

describe("project-scoped publication lease", () => {
  it("claims a scheduled post only inside the immutable job project", async () => {
    const query = vi.fn().mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ id: "81", project_id: "23", channel_id: "12" }],
    });

    await expect(claimPublicationLease({ query }, {
      postId: 81,
      projectId: 23,
      scheduleRevision: 2,
      leaseToken: "lease-token",
      overdueCutoff: new Date("2026-08-11T10:00:00.000Z"),
    })).resolves.toMatchObject({ id: "81", project_id: "23" });

    expect(String(query.mock.calls[0][0])).toContain("p.project_id = $5");
    expect(String(query.mock.calls[0][0])).toContain("rf.auto_publish_enabled = false");
    expect(query.mock.calls[0][1]).toEqual([
      81,
      "lease-token",
      2,
      new Date("2026-08-11T10:00:00.000Z"),
      23,
    ]);
  });

  it("fences the provider call by project as well as revision and lease", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [{ id: "81" }] });

    await expect(beginProviderCall({ query }, {
      postId: 81,
      projectId: 23,
      scheduleRevision: 2,
      leaseToken: "lease-token",
    })).resolves.toBe(true);

    expect(String(query.mock.calls[0][0])).toContain("project_id = $4");
    expect(String(query.mock.calls[0][0])).toContain("rf.auto_publish_enabled = false");
    expect(query.mock.calls[0][1]).toEqual([81, 2, "lease-token", 23]);
  });
});
