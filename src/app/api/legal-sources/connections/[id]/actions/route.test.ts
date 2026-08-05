import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  hasTrustedMutationOrigin: vi.fn(),
  runLegalSourceAction: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/request-origin", () => ({ hasTrustedMutationOrigin: mocks.hasTrustedMutationOrigin }));
vi.mock("@/lib/db", () => ({ getPool: () => ({}) }));
vi.mock("@/lib/legal-source-service", () => ({ runLegalSourceAction: mocks.runLegalSourceAction }));

import { POST } from "./route";

const key = "legal-sync:12345678";

function request(action: string) {
  return new NextRequest("http://localhost/api/legal-sources/connections/4/actions", {
    method: "POST",
    headers: { origin: "http://localhost", "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify({ requestKey: key, action }),
  });
}

describe("POST /api/legal-sources/connections/:id/actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hasTrustedMutationOrigin.mockReturnValue(true);
    mocks.getSessionUser.mockResolvedValue({ id: 7 });
    mocks.runLegalSourceAction.mockResolvedValue({ status: 200, body: { ok: true, action: "sync", fragmentCount: 4 } });
  });

  it("passes a stable idempotent sync action to the owned connection", async () => {
    const response = await POST(request("sync"), { params: Promise.resolve({ id: "4" }) });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, fragmentCount: 4, requestId: expect.any(String) });
    expect(mocks.runLegalSourceAction).toHaveBeenCalledWith({}, {
      userId: 7,
      connectionId: 4,
      requestKey: key,
      action: "sync",
    });
  });

  it("does not expose cabinet scraping as an adapter action", async () => {
    const response = await POST(request("scrape_cabinet"), { params: Promise.resolve({ id: "4" }) });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "bad_action" });
    expect(mocks.runLegalSourceAction).not.toHaveBeenCalled();
  });

  it("rejects explicit cross-site mutations before authentication", async () => {
    mocks.hasTrustedMutationOrigin.mockReturnValue(false);
    const response = await POST(request("disconnect"), { params: Promise.resolve({ id: "4" }) });
    expect(response.status).toBe(403);
    expect(mocks.getSessionUser).not.toHaveBeenCalled();
  });
});
