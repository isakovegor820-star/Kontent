import { ProjectRequest } from "@/test/project-request";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  requireSelectedProjectPermission: vi.fn(),
  query: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/db", () => ({ getPool: () => ({ query: mocks.query }) }));
vi.mock("@/lib/project-permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/project-permissions")>();
  return { ...actual, requireSelectedProjectPermission: mocks.requireSelectedProjectPermission };
});

import { GET } from "./route";

const FUTURE = "2026-10-08T14:00:00.000Z";

const verifiedQuality = () => ({
  score: 92,
  threshold: 85,
  passed: true,
  blockers: [],
  violations: [],
  publicationDisposition: "ready",
  metadata: {
    checkedAt: "2026-10-01T09:00:00.000Z",
    rules: { id: "aurora-post-quality", version: 1, profileVersion: 1 },
    provenance: { kind: "deterministic", validator: "validatePostQuality", trigger: "generation" },
  },
  semantic: {
    version: 1,
    status: "passed",
    passed: true,
    requiresReview: false,
    claimVerdicts: [{ verdict: "supported", sourceSpans: [{ sourceId: "src-1", start: 0, end: 12 }] }],
    provenance: {
      validatorVersion: "semantic-publication-v1",
      checkedAt: "2026-10-01T09:00:00.000Z",
      terminalVerdict: "passed",
      provider: "navy",
    },
  },
});

describe("GET /api/autopilot/calendar-plan", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: 4 });
    mocks.requireSelectedProjectPermission.mockResolvedValue({
      projectId: 88,
      userId: 4,
      role: "owner",
      version: 1,
    });
    mocks.query.mockImplementation(async (sql: string) => {
      const normalized = String(sql).replace(/\s+/g, " ");
      if (normalized.includes("from drafts")) return { rows: [], rowCount: 0 };
      return {
        rows: [{
          id: "41",
          channel_id: "7",
          status: "pending",
          revision: "3",
          channel_title: "ТехнологИИ Права",
          items: [{ i: 0, scheduledAt: FUTURE, topic: "Тема", draft: "Текст", status: "pending", quality: verifiedQuality() }],
        }],
        rowCount: 1,
      };
    });
  });

  it("отдаёт план только выбранного проекта и без чужих каналов", async () => {
    const response = await GET(new ProjectRequest(88, "http://localhost/api/autopilot/calendar-plan"));

    expect(response.status).toBe(200);
    const sql = String(mocks.query.mock.calls[0][0]).replace(/\s+/g, " ");
    expect(sql).toContain("where plan.project_id = $1");
    expect(sql).toContain("channel.project_id = plan.project_id");
    expect(sql).toContain("channel.is_active = true");
    // В окно ранжирования обязан входить approving: иначе при сосуществовании планов
    // (старый подтверждается, новый собран) карточки показали бы устаревший план.
    expect(sql).toContain("plan.status in ('pending', 'approved', 'approving')");
    expect(sql).toContain("where rank = 1 and status in ('pending', 'approved')");
    expect(mocks.query).toHaveBeenCalledWith(expect.any(String), [88]);
  });

  it("не отдаёт устаревший снимок, если в редакторе есть новые правки", async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      const normalized = String(sql).replace(/\s+/g, " ");
      if (normalized.includes("from drafts")) return { rows: [{ id: "77", version: "5" }], rowCount: 1 };
      return {
        rows: [{
          id: "41",
          channel_id: "7",
          status: "pending",
          revision: "3",
          channel_title: "ТехнологИИ Права",
          items: [{ i: 0, draftId: 77, editorVersion: 4, scheduledAt: FUTURE, topic: "Тема", draft: "Текст", status: "pending", quality: verifiedQuality() }],
        }],
        rowCount: 1,
      };
    });

    const response = await GET(new ProjectRequest(88, "http://localhost/api/autopilot/calendar-plan"));
    const body = await response.json();

    expect(body.items[0]).toMatchObject({ state: "blocked", selectable: false });
    expect(body.items[0].issues.join(" ")).toContain("правки");
  });

  it("возвращает карточки плана с правом публикации владельца", async () => {
    const response = await GET(new ProjectRequest(88, "http://localhost/api/autopilot/calendar-plan"));
    const body = await response.json();

    expect(body.ok).toBe(true);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      key: "plan-41-0",
      planId: 41,
      planRevision: 3,
      index: 0,
      channelId: 7,
      channelTitle: "ТехнологИИ Права",
      state: "ready",
      selectable: true,
      editable: true,
    });
  });

  it("читателю без права публикации карточка доступна только для просмотра", async () => {
    mocks.requireSelectedProjectPermission.mockResolvedValue({
      projectId: 88,
      userId: 4,
      role: "author",
      version: 1,
    });

    const response = await GET(new ProjectRequest(88, "http://localhost/api/autopilot/calendar-plan"));
    const body = await response.json();

    expect(body.items[0].selectable).toBe(false);
    expect(body.items[0].editable).toBe(true);
  });

  it("не отдаёт план без сессии", async () => {
    mocks.getSessionUser.mockResolvedValue(null);

    const response = await GET(new ProjectRequest(88, "http://localhost/api/autopilot/calendar-plan"));

    expect(response.status).toBe(401);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("не раскрывает план при отказе в доступе к проекту", async () => {
    const { ProjectAccessError } = await import("@/lib/project-permissions");
    mocks.requireSelectedProjectPermission.mockRejectedValue(new ProjectAccessError("membership_required"));

    const response = await GET(new ProjectRequest(88, "http://localhost/api/autopilot/calendar-plan"));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: "access_denied" });
  });

  it("честно сообщает о недоступности вместо пустого плана", async () => {
    mocks.query.mockRejectedValue(new Error("db down"));

    const response = await GET(new ProjectRequest(88, "http://localhost/api/autopilot/calendar-plan"));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: "unavailable" });
  });
});
