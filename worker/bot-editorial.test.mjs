import { describe, expect, it, vi } from "vitest";

import { decideBotApproval, listBotApprovalItems } from "./bot-editorial.mjs";

describe("Telegram editorial bridge", () => {
  it("lists only open project-scoped reviews for owner or approver", async () => {
    const query = vi.fn(async () => ({ rows: [{ request_id: 9, text: "Точный текст" }] }));
    const rows = await listBotApprovalItems({ query }, { userId: 5, projectId: 7 });
    expect(rows).toHaveLength(1);
    expect(query.mock.calls[0][0]).toContain("request.status = 'open'");
    expect(query.mock.calls[0][0]).toContain("reviewer.role in ('owner','approver')");
    expect(query.mock.calls[0][1]).toEqual([7, 5]);
  });

  it("never returns a draft without a human comment", async () => {
    const pool = { connect: vi.fn() };
    await expect(decideBotApproval(pool, {
      userId: 5,
      projectId: 7,
      requestId: 9,
      decision: "request_changes",
      note: "   ",
    })).rejects.toThrow("decision_note_required");
    expect(pool.connect).not.toHaveBeenCalled();
  });
});
