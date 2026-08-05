import { describe, expect, it, vi } from "vitest";

import type { DraftCreateInput, DraftUpdateInput } from "./draft-types";
import {
  attestDraftReviewForUser,
  createDraftForUser,
  DraftConflictError,
  DraftValidationError,
  parseDraftCreateInput,
  parseDraftUpdateInput,
  updateDraftForUser,
} from "./server-drafts";

const input: DraftCreateInput = {
  clientKey: "draft_12345678-1234-4234-9234-123456789abc",
  text: "Текст черновика",
  media: null,
  scheduledAt: "2026-08-05T10:00:00.000Z",
  origin: "manual",
  sourceRef: null,
  channelIds: [11],
  aiValidation: null,
};

const row = {
  id: "41",
  text: input.text,
  media: null,
  scheduled_at: input.scheduledAt,
  origin: input.origin,
  source_ref: null,
  client_key: input.clientKey,
  version: "3",
  review_policy_version: "1",
  ai_validation: null,
  human_reviewed_version: null,
  human_reviewed_at: null,
  created_at: "2026-08-01T10:00:00.000Z",
  updated_at: "2026-08-01T12:00:00.000Z",
  destinations: [
    {
      channel_id: "11",
      network: "tg",
      title: "Канал",
      handle: "channel",
      is_active: true,
    },
  ],
};

function fakePool(query: ReturnType<typeof vi.fn>) {
  const release = vi.fn();
  return {
    pool: { connect: vi.fn(async () => ({ query, release })) },
    release,
  };
}

describe("draft input boundary", () => {
  it("normalizes a valid create and rejects duplicate/unowned-shaped destination input", () => {
    expect(parseDraftCreateInput(input)).toEqual(input);
    expect(() => parseDraftCreateInput({ ...input, channelIds: [11, 11] })).toThrowError(
      new DraftValidationError("bad_destinations"),
    );
    expect(() => parseDraftCreateInput({ ...input, clientKey: "short" })).toThrowError(
      new DraftValidationError("bad_client_key"),
    );
  });

  it("requires an optimistic version for updates", () => {
    expect(parseDraftUpdateInput({ ...input, version: 7 })).toMatchObject({ version: 7 });
    expect(() => parseDraftUpdateInput({ ...input, version: 0 })).toThrowError(
      new DraftValidationError("bad_version"),
    );
  });
});

describe("server draft transactions", () => {
  it("returns the existing row for an idempotency-key replay without replacing destinations", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("select id from channels")) return { rowCount: 1, rows: [{ id: "11" }] };
      if (sql.includes("insert into drafts")) return { rowCount: 0, rows: [] };
      if (sql.includes("select id from drafts where")) return { rowCount: 1, rows: [{ id: "41" }] };
      if (sql.includes("select d.id")) return { rowCount: 1, rows: [row] };
      return { rowCount: 0, rows: [] };
    });
    const { pool, release } = fakePool(query);

    const result = await createDraftForUser(5, input, pool as never);

    expect(result).toMatchObject({ created: false, draft: { id: 41, version: 3 } });
    expect(query.mock.calls.some(([sql]) => String(sql).includes("delete from draft_destinations"))).toBe(false);
    expect(query).toHaveBeenCalledWith("commit");
    expect(release).toHaveBeenCalledOnce();
  });

  it("rejects a destination not owned and active before inserting anything", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("select id from channels")) return { rowCount: 0, rows: [] };
      return { rowCount: 0, rows: [] };
    });
    const { pool } = fakePool(query);

    await expect(createDraftForUser(5, input, pool as never)).rejects.toMatchObject({
      code: "bad_destinations",
    });
    expect(query.mock.calls.some(([sql]) => String(sql).includes("insert into drafts"))).toBe(false);
    expect(query).toHaveBeenCalledWith("rollback");
  });

  it("rejects a media asset owned by another user", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("select id from channels")) return { rowCount: 1, rows: [{ id: "11" }] };
      if (sql.includes("select kind from media_assets")) return { rowCount: 0, rows: [] };
      return { rowCount: 0, rows: [] };
    });
    const { pool } = fakePool(query);

    await expect(createDraftForUser(5, {
      ...input,
      media: { kind: "image", label: "Картинка", hue: 42, assetId: "99" },
    }, pool as never)).rejects.toMatchObject({ code: "bad_media" });
    expect(query.mock.calls.some(([sql]) => String(sql).includes("insert into drafts"))).toBe(false);
  });

  it("turns a stale PATCH into a conflict carrying the current server version", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("select id from channels")) return { rowCount: 1, rows: [{ id: "11" }] };
      if (sql.includes("update drafts")) return { rowCount: 0, rows: [] };
      if (sql.includes("select d.id")) return { rowCount: 1, rows: [row] };
      return { rowCount: 0, rows: [] };
    });
    const { pool } = fakePool(query);
    const update: DraftUpdateInput = { ...input, version: 2 };

    const error = await updateDraftForUser(5, 41, update, pool as never).catch((reason) => reason);
    expect(error).toBeInstanceOf(DraftConflictError);
    expect(error.current).toMatchObject({ id: 41, version: 3 });
    expect(query).toHaveBeenCalledWith("rollback");
    expect(query.mock.calls.some(([sql]) => String(sql).includes("delete from draft_destinations"))).toBe(false);
  });

  it("ACKs human review by advancing and binding the exact AI draft version", async () => {
    const aiValidation = {
      version: 1,
      status: "not_checked",
      requiresReview: true,
      blockerCodes: [],
      provenance: {
        validatorVersion: "fact-ledger-v1",
        ledgerHash: "fl1-1234abcd",
        checkedAt: "2026-08-01T11:55:00.000Z",
        coverage: "deterministic",
        semanticEntailment: "not_checked",
        rulesRun: ["unsupported_claim"],
        sourceIds: ["brief:1"],
      },
    };
    let selected = 0;
    const query = vi.fn(async (sql: string, _params?: unknown[]) => {
      void _params;
      if (sql.includes("select d.id")) {
        selected += 1;
        return {
          rowCount: 1,
          rows: [{
            ...row,
            origin: "ai",
            ai_validation: aiValidation,
            version: selected === 1 ? "3" : "4",
            human_reviewed_version: selected === 1 ? null : "4",
            human_reviewed_at:
              selected === 1 ? null : "2026-08-01T12:05:00.000Z",
          }],
        };
      }
      if (sql.includes("update drafts")) return { rowCount: 1, rows: [{ id: "41" }] };
      return { rowCount: 0, rows: [] };
    });
    const { pool } = fakePool(query);

    const reviewed = await attestDraftReviewForUser(5, 41, 3, pool as never);

    expect(reviewed).toMatchObject({
      id: 41,
      version: 4,
      human_review: { policy_version: 1, draft_version: 4 },
    });
    const mutation = query.mock.calls.find(([sql]) => String(sql).includes("update drafts"));
    expect(mutation?.[1]).toEqual([41, 5, 3, 1]);
    expect(query).toHaveBeenCalledWith("commit");
  });
});
