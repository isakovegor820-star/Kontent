import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dictionary: vi.fn(),
  permission: vi.fn(),
}));

vi.mock("./brand-dictionary-service", () => ({
  getBrandDictionarySnapshotForProject: mocks.dictionary,
}));
vi.mock("./project-permissions", () => ({
  requireSelectedProjectPermission: mocks.permission,
}));

import { analyzeLegalTypography } from "./legal-typographer";
import {
  applyProjectTypography,
  getLatestTypographyRunForDraft,
  recheckTypographyForPublication,
} from "./typography-service";

function applyPool() {
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql === "begin" || sql === "commit" || sql === "rollback") return { rows: [] };
      if (sql.includes("from project_typography_runs") && sql.includes("request_key")) return { rows: [] };
      if (sql.includes("insert into project_typography_runs")) {
        return {
          rows: [{
            id: "71",
            source_text: params?.[7],
            result_text: params?.[8],
            source_text_hash: params?.[9],
            result_text_hash: params?.[10],
            dictionary_version: params?.[6],
            rules_version: params?.[5],
            suggestions: JSON.parse(String(params?.[11])),
            accepted_suggestion_ids: JSON.parse(String(params?.[12])),
            rejected_suggestion_ids: JSON.parse(String(params?.[13])),
            review_complete: params?.[14],
            undone_at: null,
          }],
        };
      }
      if (sql.includes("insert into audit_events")) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    }),
    release: vi.fn(),
  };
  return { client, pool: { connect: vi.fn().mockResolvedValue(client) } };
}

describe("typography service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.permission.mockResolvedValue({ projectId: 23, userId: 5, role: "author" });
    mocks.dictionary.mockResolvedValue({ projectId: 23, version: 3, entries: [], updatedAt: null });
  });

  it("reanalyzes on the server, applies safe changes and persists a bounded audit snapshot", async () => {
    const { client, pool } = applyPool();
    const result = await applyProjectTypography({
      pool: pool as never,
      actorUserId: 5,
      requestKey: "typography:test-safe-0001",
      draftId: null,
      text: "Срок  3-5 дней и работа.",
      expectedDictionaryVersion: 3,
      acceptedSuggestionIds: "safe",
      rejectedSuggestionIds: [],
      formatQuotes: false,
    });

    expect(result.resultText).toBe("Срок 3–5 дней и\u00a0работа.");
    expect(result.dictionaryVersion).toBe(3);
    expect(result.reviewComplete).toBe(true);
    expect(mocks.permission).toHaveBeenCalledWith(client, 5, "content.edit");
    const insert = client.query.mock.calls.find(([sql]) => String(sql).includes("insert into project_typography_runs"));
    expect(insert?.[1]?.[4]).toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.parse(String(insert?.[1]?.[11]))).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: "spaces.duplicate", safe: true }),
      expect.objectContaining({ rule: "range.numeric", safe: true }),
    ]));
    expect(String(insert?.[0])).not.toContain("request body");
  });

  it("applies newly revealed safe corrections until the text is stable", async () => {
    const { client, pool } = applyPool();
    const result = await applyProjectTypography({
      pool: pool as never,
      actorUserId: 5,
      requestKey: "typography:test-fixed-point",
      draftId: null,
      text: "Вообщем, кто - то решил, во - первых, учавствовать.",
      expectedDictionaryVersion: 3,
      acceptedSuggestionIds: "safe",
      rejectedSuggestionIds: [],
      formatQuotes: false,
    });

    expect(result.resultText).toBe("В\u00a0общем, кто-то решил, во-первых, участвовать.");
    expect(result.reviewComplete).toBe(true);
    expect(result.remainingSuggestions).toEqual([]);
    expect(result.acceptedSuggestionIds.length).toBeGreaterThan(4);
    expect(analyzeLegalTypography(result.resultText)).toEqual([]);
    const insert = client.query.mock.calls.find(([sql]) => String(sql).includes("insert into project_typography_runs"));
    expect(JSON.parse(String(insert?.[1]?.[11]))).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: "typo.вообщем", safe: true }),
      expect.objectContaining({ rule: "nbsp.short-word", safe: true }),
    ]));
  });

  it("persists an explicit reject-all review without changing the text", async () => {
    const text = "Срок  3-5 дней";
    const suggestions = analyzeLegalTypography(text);
    const { pool } = applyPool();
    const result = await applyProjectTypography({
      pool: pool as never,
      actorUserId: 5,
      requestKey: "typography:test-reject-01",
      draftId: null,
      text,
      expectedDictionaryVersion: 3,
      acceptedSuggestionIds: [],
      rejectedSuggestionIds: suggestions.map((item) => item.id),
      formatQuotes: false,
    });

    expect(result.resultText).toBe(text);
    expect(result.reviewComplete).toBe(true);
    expect(result.rejectedSuggestionIds).toEqual(suggestions.map((item) => item.id));
  });

  it("replays only the exact full user intent and rejects legacy or changed selections", async () => {
    const sourceHash = createHash("sha256").update("Текст", "utf8").digest("hex");
    const requestHash = createHash("sha256").update(JSON.stringify({
      draftId: null,
      sourceTextHash: sourceHash,
      dictionaryVersion: 3,
      acceptedSuggestionIds: [],
      rejectedSuggestionIds: [],
      formatQuotes: false,
    }), "utf8").digest("hex");
    const replayRow = {
      id: "73",
      source_text: "Текст",
      result_text: "Текст",
      source_text_hash: sourceHash,
      result_text_hash: sourceHash,
      dictionary_version: 3,
      rules_version: "aurora-ru-typographer-v2",
      request_hash: requestHash,
      suggestions: [],
      accepted_suggestion_ids: [],
      rejected_suggestion_ids: [],
      review_complete: true,
      undone_at: null,
    };
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql === "begin" || sql === "commit" || sql === "rollback") return { rows: [] };
        if (sql.includes("from project_typography_runs") && sql.includes("request_key")) {
          return { rows: [replayRow] };
        }
        throw new Error(`unexpected query: ${sql}`);
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn().mockResolvedValue(client) };
    const base = {
      pool: pool as never,
      actorUserId: 5,
      requestKey: "typography:test-replay-01",
      draftId: null,
      text: "Текст",
      expectedDictionaryVersion: 3,
      acceptedSuggestionIds: [] as string[],
      rejectedSuggestionIds: [] as string[],
      formatQuotes: false,
    };

    await expect(applyProjectTypography(base)).resolves.toMatchObject({ id: 73, duplicate: true });
    await expect(applyProjectTypography({ ...base, formatQuotes: true }))
      .rejects.toMatchObject({ code: "request_conflict" });
    await expect(applyProjectTypography({ ...base, acceptedSuggestionIds: "safe" }))
      .rejects.toMatchObject({ code: "request_conflict" });

    // A persisted legacy fingerprint must never be guessed from partial columns.
    replayRow.request_hash = null as never;
    await expect(applyProjectTypography(base))
      .rejects.toMatchObject({ code: "request_conflict" });
  });

  it("restores the exact persisted draft review and undo state after a reload", async () => {
    const db = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes("from drafts")) {
          expect(params).toEqual([41, 23]);
          return { rows: [{ text: "Срок  3-5 дней" }] };
        }
        if (sql.includes("from project_typography_runs")) {
          expect(sql).toContain("result_text = $3");
          expect(params).toEqual([23, 41, "Срок  3-5 дней"]);
          return { rows: [{
            id: "72",
            source_text: "Срок  3-5 дней",
            result_text: "Срок  3-5 дней",
            source_text_hash: "a".repeat(64),
            result_text_hash: "a".repeat(64),
            dictionary_version: 3,
            rules_version: "aurora-ru-typographer-v2",
            suggestions: [],
            accepted_suggestion_ids: [],
            rejected_suggestion_ids: ["typ-a1"],
            review_complete: true,
            undone_at: null,
          }] };
        }
        throw new Error(`unexpected query: ${sql}`);
      }),
    };

    await expect(getLatestTypographyRunForDraft({
      db: db as never,
      actorUserId: 5,
      draftId: 41,
    })).resolves.toMatchObject({
      id: 72,
      rejectedSuggestionIds: ["typ-a1"],
      reviewComplete: true,
      currentReview: true,
    });
    expect(mocks.permission).toHaveBeenCalledWith(db, 5, "project.read");
  });

  it("rejects suggestion ids that the authoritative analysis did not produce", async () => {
    const { pool } = applyPool();
    await expect(applyProjectTypography({
      pool: pool as never,
      actorUserId: 5,
      requestKey: "typography:test-stale-0001",
      draftId: null,
      text: "Срок 3-5 дней",
      expectedDictionaryVersion: 3,
      acceptedSuggestionIds: ["typ-deadbeef"],
      rejectedSuggestionIds: [],
      formatQuotes: false,
    })).rejects.toMatchObject({ code: "stale_suggestions" });
  });

  it("fails publication closed until the exact text and dictionary version were reviewed", async () => {
    const db = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
    };
    await expect(recheckTypographyForPublication({
      db: db as never,
      projectId: 23,
      text: "Срок  3-5 дней",
    })).rejects.toMatchObject({
      code: "typography_review_required",
      dictionaryVersion: 3,
    });
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("review_complete = true"),
      expect.arrayContaining([23, "aurora-ru-typographer-v2", 3]),
    );
  });

  it("records the personal owner's publish-as-is decision without a second confirmation", async () => {
    const db = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
    };
    await expect(recheckTypographyForPublication({
      db: db as never,
      projectId: 23,
      text: "Срок  3-5 дней",
      allowPublishAsIs: true,
    })).resolves.toMatchObject({
      status: "published_as_is",
      suggestionCount: 2,
      reviewRunId: null,
    });
  });

  it("includes the dictionary version in a clean publication snapshot", async () => {
    const db = { query: vi.fn() };
    const snapshot = await recheckTypographyForPublication({
      db: db as never,
      projectId: 23,
      text: "Текст оформлен.",
    });
    expect(snapshot).toMatchObject({
      rulesVersion: "aurora-ru-typographer-v2",
      dictionaryVersion: 3,
      status: "clean",
      suggestionCount: 0,
    });
    expect(snapshot.textHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(db.query).not.toHaveBeenCalled();
  });
});
