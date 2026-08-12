import { describe, expect, it, vi } from "vitest";

import { ensureDraftEditorialBootstrap } from "./draft-editorial-bootstrap.mjs";

const draft = {
  id: 41,
  project_id: 7,
  user_id: 5,
  version: 1,
  text: "Готовый пост",
  media: null,
  tracking: {},
  origin: "autopilot",
  purpose: "needs_review",
  source_ref: { kind: "monthly_campaign", itemId: 9 },
  scheduled_at: "2026-09-01T16:00:00.000Z",
  scheduled_timezone: "Europe/Moscow",
  scheduled_local_date: "2026-09-01",
  scheduled_local_time: "19:00",
  scheduled_offset: "+03:00",
  scheduled_disambiguation: "reject",
  channel_ids: [12],
  publication_preferences: null,
};

describe("monthly draft editorial bootstrap", () => {
  it("creates a hash-bound revision, workflow, and audit in one caller transaction", async () => {
    const statements = [];
    const query = vi.fn(async (sql) => {
      statements.push(sql);
      if (sql.includes("from project_members")) return { rows: [{ role: "owner" }] };
      if (sql.includes("from drafts draft")) return { rows: [draft] };
      if (sql.includes("insert into draft_revisions")) return { rows: [{ id: 81 }] };
      return { rows: [], rowCount: 1 };
    });

    const result = await ensureDraftEditorialBootstrap({ query }, {
      draftId: 41,
      actorUserId: 5,
      projectId: 7,
    });

    expect(result.contentHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.snapshot).toMatchObject({
      text: "Готовый пост",
      origin: "autopilot",
      channelIds: [12],
      schedule: { localDate: "2026-09-01", localTime: "19:00" },
    });
    expect(statements.findIndex((sql) => sql.includes("insert into draft_revisions")))
      .toBeLessThan(statements.findIndex((sql) => sql.includes("insert into draft_editorial_workflows")));
    expect(statements.some((sql) => sql.includes("'draft.revision_created'"))).toBe(true);
  });

  it("fails closed when the plan actor no longer has an editing role", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    await expect(ensureDraftEditorialBootstrap({ query }, {
      draftId: 41,
      actorUserId: 5,
      projectId: 7,
    })).rejects.toThrow("cannot edit project content");
    expect(query).toHaveBeenCalledTimes(1);
  });
});
