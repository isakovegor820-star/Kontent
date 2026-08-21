import { describe, expect, it, vi } from "vitest";

import {
  deriveGrowthLifecycle,
  GrowthArtifactLinkError,
  linkGrowthMoveDraftInTransaction,
  linkGrowthMovePlanInTransaction,
} from "./growth";

describe("Growth artifact lifecycle links", () => {
  it("keeps a move open until a real downstream artifact exists", () => {
    expect(deriveGrowthLifecycle({
      hasDraft: false,
      draftScheduledAt: null,
      hasPlan: false,
      postId: null,
      postStatus: null,
      outcomeMaturity: null,
    })).toBe("open");
  });

  it("links a project-owned draft to an open content move and records safe telemetry", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: "7", channel_id: "11", kind: "topic", status: "open", artifact_draft_id: null }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await linkGrowthMoveDraftInTransaction({
      db: { query } as never,
      projectId: 3,
      actorUserId: 5,
      moveId: 7,
      draftId: 13,
      channelIds: [11],
    });

    expect(String(query.mock.calls[1]?.[0])).toContain("artifact_draft_id");
    expect(query.mock.calls[1]?.[1]).toEqual([7, 3, 13]);
    expect(JSON.stringify(query.mock.calls[2]?.[1])).not.toContain("text");
  });

  it("rejects linking a skipped move even if the ids belong to the project", async () => {
    const query = vi.fn().mockResolvedValueOnce({
      rows: [{ id: "7", channel_id: "11", kind: "offer", status: "skipped", artifact_draft_id: null }],
    });
    await expect(linkGrowthMoveDraftInTransaction({
      db: { query } as never,
      projectId: 3,
      actorUserId: 5,
      moveId: 7,
      draftId: 13,
      channelIds: [11],
    })).rejects.toEqual(new GrowthArtifactLinkError("growth_move_not_found"));
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("links rhythm only to the exact plan and channel", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ kind: "rhythm" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    await linkGrowthMovePlanInTransaction({
      db: { query } as never,
      projectId: 3,
      actorUserId: 5,
      moveId: 9,
      planId: 21,
      channelId: 11,
    });
    expect(query.mock.calls[0]?.[1]).toEqual([9, 3, 11, 21]);
    expect(String(query.mock.calls[0]?.[0])).toContain("status = 'open'");
  });
});
