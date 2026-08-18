import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  getPool: vi.fn(),
  checkRateLimit: vi.fn(),
  createMonthlyCampaign: vi.fn(),
  listMonthlyCampaigns: vi.fn(),
  requestMonthlyCampaignRegeneration: vi.fn(),
  transitionMonthlyCampaignPlan: vi.fn(),
  getMonthlyCampaign: vi.fn(),
  createMonthlyCampaignPlan: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/db", () => ({ getPool: mocks.getPool }));
vi.mock("@/lib/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rate-limit")>();
  return { ...actual, checkRateLimit: mocks.checkRateLimit };
});
vi.mock("@/lib/monthly-campaign-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/monthly-campaign-service")>();
  return {
    ...actual,
    createMonthlyCampaign: mocks.createMonthlyCampaign,
    listMonthlyCampaigns: mocks.listMonthlyCampaigns,
    requestMonthlyCampaignRegeneration: mocks.requestMonthlyCampaignRegeneration,
    transitionMonthlyCampaignPlan: mocks.transitionMonthlyCampaignPlan,
    getMonthlyCampaign: mocks.getMonthlyCampaign,
    createMonthlyCampaignPlan: mocks.createMonthlyCampaignPlan,
  };
});

import { ProjectAccessError } from "@/lib/project-permissions";
import { GET, POST } from "./route";
import { POST as regenerate } from "./[campaignId]/plans/[planId]/regenerate/route";
import { PATCH as transition } from "./[campaignId]/plans/[planId]/route";
import { POST as createPlan } from "./[campaignId]/plans/route";

function request(path: string, method: string, body?: unknown, headers: Record<string, string> = {}) {
  return new NextRequest(`https://aurora.test${path}`, {
    method,
    headers: { origin: "https://aurora.test", "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("monthly campaign API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: 11 });
    mocks.getPool.mockReturnValue({});
    mocks.checkRateLimit.mockResolvedValue({ allowed: true, limit: 30, remaining: 29, retryAfter: 0 });
    mocks.createMonthlyCampaign.mockResolvedValue({ campaign: { id: 41 }, duplicate: false });
    mocks.listMonthlyCampaigns.mockResolvedValue([{ id: 41 }]);
    mocks.requestMonthlyCampaignRegeneration.mockResolvedValue({
      operationId: 91, status: "pending", duplicate: false, planVersion: 5, targetItemIds: [62],
    });
    mocks.transitionMonthlyCampaignPlan.mockResolvedValue({ id: 52, status: "in_review", version: 5 });
    mocks.getMonthlyCampaign.mockResolvedValue({
      campaign: {
        startsOn: "2026-09-01",
        endsOn: "2026-09-30",
        rubrics: ["Практика", "Ошибки", "Вопросы"],
        practiceMix: [{ name: "Корпоративное право", kind: "practice", weight: 100 }],
        funnelStages: ["awareness", "consideration", "consultation"],
        importantDates: [],
        audience: "Собственники бизнеса",
      },
    });
    mocks.createMonthlyCampaignPlan.mockResolvedValue({ plan: { id: 52 }, duplicate: false });
  });

  it("rejects a cross-site mutation before auth or persistence", async () => {
    const response = await POST(request("/api/monthly-campaigns", "POST", {
      brief: {}, idempotencyKey: "campaign:create:1",
    }, { origin: "https://attacker.example", "sec-fetch-site": "cross-site" }));
    expect(response.status).toBe(403);
    expect(mocks.getSessionUser).not.toHaveBeenCalled();
    expect(mocks.createMonthlyCampaign).not.toHaveBeenCalled();
  });

  it("does not accept a client-provided project selector", async () => {
    const response = await POST(request("/api/monthly-campaigns", "POST", {
      brief: {}, idempotencyKey: "campaign:create:1", projectId: 999,
    }));
    expect(response.status).toBe(400);
    expect(mocks.createMonthlyCampaign).not.toHaveBeenCalled();
  });

  it("requires JSON and rejects the real streamed body above 32 KiB", async () => {
    const unsupported = await POST(request(
      "/api/monthly-campaigns",
      "POST",
      { brief: {}, idempotencyKey: "campaign:create:1" },
      { "content-type": "text/plain" },
    ));
    expect(unsupported.status).toBe(415);

    const oversized = await POST(request("/api/monthly-campaigns", "POST", {
      brief: { goal: "x".repeat(33 * 1024) }, idempotencyKey: "campaign:create:1",
    }, { "content-length": "2" }));
    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toMatchObject({ error: "body_too_large" });
    expect(mocks.createMonthlyCampaign).not.toHaveBeenCalled();
  });

  it("uses the authenticated actor and returns an idempotent creation status", async () => {
    const response = await POST(request("/api/monthly-campaigns", "POST", {
      brief: { goal: "План" }, idempotencyKey: "campaign:create:1",
    }));
    expect(response.status).toBe(201);
    expect(mocks.createMonthlyCampaign).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: 11,
      idempotencyKey: "campaign:create:1",
    }));
    expect(mocks.createMonthlyCampaign.mock.calls[0][0]).not.toHaveProperty("projectId");
  });

  it("maps a cross-project/role denial without leaking campaign existence", async () => {
    mocks.listMonthlyCampaigns.mockRejectedValue(new ProjectAccessError("permission_denied"));
    const response = await GET(request("/api/monthly-campaigns", "GET"));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: "access_denied" });
  });

  it("fails regeneration closed when its limiter is unavailable", async () => {
    mocks.checkRateLimit.mockResolvedValue({
      allowed: false, limit: 30, remaining: 0, retryAfter: 30, unavailable: true,
    });
    const response = await regenerate(
      request("/api/monthly-campaigns/41/plans/52/regenerate", "POST", {
        scope: "item", itemId: 62, expectedPlanVersion: 4, idempotencyKey: "regenerate:item:62",
      }),
      { params: Promise.resolve({ campaignId: "41", planId: "52" }) },
    );
    expect(response.status).toBe(503);
    expect(mocks.requestMonthlyCampaignRegeneration).not.toHaveBeenCalled();
    expect(mocks.checkRateLimit).toHaveBeenCalledWith(
      "monthly-campaign:regenerate:user:11", 30, 3_600, { failureMode: "closed" },
    );
  });

  it("returns a durable pending operation rather than a fake generated result", async () => {
    const response = await regenerate(
      request("/api/monthly-campaigns/41/plans/52/regenerate", "POST", {
        scope: "item", itemId: 62, expectedPlanVersion: 4, idempotencyKey: "regenerate:item:62",
      }),
      { params: Promise.resolve({ campaignId: "41", planId: "52" }) },
    );
    expect(response.status).toBe(202);
    const json = await response.json();
    expect(json).toMatchObject({ ok: true, operation: { status: "pending", targetItemIds: [62] } });
    expect(json).not.toHaveProperty("generated");
  });

  it("delegates approval with the exact optimistic plan version", async () => {
    const response = await transition(
      request("/api/monthly-campaigns/41/plans/52", "PATCH", {
        action: "approve", expectedPlanVersion: 7,
      }),
      { params: Promise.resolve({ campaignId: "41", planId: "52" }) },
    );
    expect(response.status).toBe(200);
    expect(mocks.transitionMonthlyCampaignPlan).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: 11, campaignId: 41, planId: 52, action: "approve", expectedPlanVersion: 7,
    }));
  });

  it("builds the initial month on the server instead of trusting client-supplied topics", async () => {
    const response = await createPlan(
      request("/api/monthly-campaigns/41/plans", "POST", {
        generationMode: "editorial_seed",
        expectedCampaignVersion: 3,
        idempotencyKey: "monthly-plan:create:41:3",
      }),
      { params: Promise.resolve({ campaignId: "41" }) },
    );
    expect(response.status).toBe(201);
    expect(mocks.getMonthlyCampaign).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: 11,
      campaignId: 41,
    }));
    expect(mocks.createMonthlyCampaignPlan).toHaveBeenCalledWith(expect.objectContaining({
      expectedCampaignVersion: 3,
      items: expect.arrayContaining([
        expect.objectContaining({ itemKey: "day-2026-09-01", state: "detailed" }),
        expect.objectContaining({ itemKey: "day-2026-09-30", state: "topic" }),
      ]),
    }));
    expect(mocks.createMonthlyCampaignPlan.mock.calls[0][0].items).toHaveLength(30);
  });
});
