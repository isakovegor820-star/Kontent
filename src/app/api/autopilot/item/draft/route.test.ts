import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mock = vi.hoisted(() => ({ query: vi.fn(), txQuery: vi.fn(), assess: vi.fn(), enqueue: vi.fn(), release: vi.fn() }));
vi.mock("@/lib/db", () => ({ getPool: () => ({ query: mock.query, connect: async () => ({ query: mock.txQuery, release: mock.release }) }) }));
vi.mock("@/lib/session", () => ({ getSessionUser: async () => ({ id: 3 }) }));
vi.mock("@/lib/request-origin", () => ({ hasTrustedMutationOrigin: () => true }));
vi.mock("@/lib/project-permissions", () => ({ ProjectAccessError: class extends Error {}, requireSelectedProjectPermission: async () => ({ projectId: 11 }), requireProjectPermission: async () => ({ projectId: 11 }) }));
vi.mock("@/lib/autopilot", () => ({ resolveChannel: async () => 7, enqueueAutopilotPost: mock.enqueue }));
vi.mock("@/lib/autopilot-quality.mjs", () => ({ assessAutopilotDraft: mock.assess }));
vi.mock("@/lib/editorial-approval", () => ({ recordDraftRevisionInTransaction: vi.fn() }));
import { PATCH, POST } from "./route";

const request = (body: unknown, method = "PATCH") => new NextRequest("http://localhost/api/autopilot/item/draft", { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const result = (rows: unknown[]) => ({ rows, rowCount: rows.length });
let staleDraft: boolean;
let stalePlan: boolean;
let alreadyPublished: boolean;
let plan: { id: string; channel_id: string; revision: string; items: Record<string, unknown>[] };
let draft: { id: string; version: string; text: string; media: unknown; formatting: unknown[]; scheduled_at: string; scheduled_timezone: string };

beforeEach(() => {
  vi.clearAllMocks();
  staleDraft = false; stalePlan = false; alreadyPublished = false;
  plan = { id: "44", channel_id: "7", revision: "2", items: [{ i: 0, draft: "Старый текст", draftId: 301, scheduledAt: new Date(Date.now() + 3_600_000).toISOString(), status: "pending", humanAttestation: { userId: 3 } }] };
  draft = { id: "301", version: "3", text: "Новый текст редактора", media: { kind: "image", assetId: 19 }, formatting: [{ type: "bold", offset: 0, length: 5 }], scheduled_at: new Date(Date.now() + 7_200_000).toISOString(), scheduled_timezone: "Europe/Moscow" };
  mock.assess.mockResolvedValue({ passed: true, score: 92, threshold: 80, blockers: [], violations: [], publicationDisposition: "ready", semantic: { status: "passed", requiresReview: false } });
  mock.query.mockImplementation(async (sql: string) => {
    if (sql.includes("from autopilot_plan")) return result([structuredClone(plan)]);
    if (sql.includes("from drafts")) return result([structuredClone(draft)]);
    if (sql.includes("from content_brief")) return result([]);
    throw new Error(`Unexpected query: ${sql}`);
  });
  mock.txQuery.mockImplementation(async (sql: string) => {
    if (["begin", "commit", "rollback"].includes(sql)) return result([]);
    if (sql.includes("from autopilot_plan")) return result(stalePlan ? [] : [structuredClone(plan)]);
    if (sql.includes("from drafts d")) return result([{ version: staleDraft ? "4" : "3", channel_ids: ["7"] }]);
    if (sql.includes("operation.draft_id")) return result(alreadyPublished ? [{ id: "800" }] : []);
    if (sql.includes("update autopilot_plan")) return result([{ revision: "3" }]);
    throw new Error(`Unexpected transaction: ${sql}`);
  });
});

describe("Autopilot editor save and return", () => {
  it("rechecks edited text and saves the exact media, formatting and time without scheduling", async () => {
    const response = await PATCH(request({ draftId: 301, draftVersion: 3 }));
    expect(response.status).toBe(200);
    expect(mock.assess).toHaveBeenCalledWith(expect.objectContaining({ text: draft.text, trigger: "edit_recheck" }));
    const update = mock.txQuery.mock.calls.find(([sql]) => sql.includes("update autopilot_plan"));
    const items = JSON.parse(update![1][2]);
    expect(items[0]).toMatchObject({ draft: draft.text, media: draft.media, formatting: draft.formatting, scheduledAt: draft.scheduled_at, editorVersion: 3, status: "pending" });
    expect(items[0]).not.toHaveProperty("humanAttestation");
    expect(mock.enqueue).not.toHaveBeenCalled();
    expect(mock.txQuery.mock.calls.some(([sql]) => sql.includes("insert into posts"))).toBe(false);
    expect(mock.release).toHaveBeenCalledOnce();
  });

  it.each(["draft", "plan"])("rejects a concurrent %s change without applying the snapshot", async (kind) => {
    staleDraft = kind === "draft"; stalePlan = kind === "plan";
    const response = await PATCH(request({ draftId: 301, draftVersion: 3 }));
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe(kind === "draft" ? "version_conflict" : "stale_plan");
    expect(mock.txQuery).toHaveBeenCalledWith("rollback");
    expect(mock.txQuery.mock.calls.some(([sql]) => sql.includes("update autopilot_plan"))).toBe(false);
  });

  it("does not return a legacy draft already published through Composer as a new candidate", async () => {
    alreadyPublished = true;
    const response = await PATCH(request({ draftId: 301, draftVersion: 3 }));
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("post_changed");
    expect(mock.enqueue).not.toHaveBeenCalled();
  });

  it("rejects expired schedules before evaluating or mutating content", async () => {
    draft.scheduled_at = new Date(Date.now() - 60_000).toISOString();
    expect((await PATCH(request({ draftId: 301, draftVersion: 3 }))).status).toBe(422);
    expect(mock.assess).not.toHaveBeenCalled();
    expect(mock.txQuery).not.toHaveBeenCalled();
  });

  it.each([null, [], "invalid"])("rejects malformed request bodies", async (body) => {
    expect((await PATCH(request(body))).status).toBe(400);
    expect((await POST(request(body, "POST"))).status).toBe(400);
    expect(mock.query).not.toHaveBeenCalled();
  });
});
