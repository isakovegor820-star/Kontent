import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  list: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.session }));
vi.mock("@/lib/editorial-approval", async () => {
  const actual = await vi.importActual<typeof import("@/lib/editorial-approval")>("@/lib/editorial-approval");
  return { ...actual, listDraftRevisionHistoryForUser: mocks.list };
});

import { GET } from "./route";

describe("GET /api/drafts/:id/revisions", () => {
  beforeEach(() => {
    mocks.session.mockReset();
    mocks.list.mockReset();
  });

  it("returns only the authenticated user's project-scoped revision history", async () => {
    mocks.session.mockResolvedValue({ id: 7 });
    mocks.list.mockResolvedValue([{ id: 9, draftId: 12, draftVersion: 3, snapshot: { text: "Версия" } }]);
    const response = await GET(
      new NextRequest("http://localhost/api/drafts/12/revisions"),
      { params: Promise.resolve({ id: "12" }) },
    );
    expect(response.status).toBe(200);
    expect(mocks.list).toHaveBeenCalledWith(7, 12);
    expect(await response.json()).toMatchObject({ ok: true, revisions: [{ draftVersion: 3 }] });
  });

  it("does not query history for anonymous or invalid requests", async () => {
    mocks.session.mockResolvedValue(null);
    expect((await GET(new NextRequest("http://localhost/api/drafts/12/revisions"), { params: Promise.resolve({ id: "12" }) })).status).toBe(401);
    mocks.session.mockResolvedValue({ id: 7 });
    expect((await GET(new NextRequest("http://localhost/api/drafts/no/revisions"), { params: Promise.resolve({ id: "no" }) })).status).toBe(400);
    expect(mocks.list).not.toHaveBeenCalled();
  });
});
