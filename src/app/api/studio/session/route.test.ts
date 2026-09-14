import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  loadStudioChatSessionForUser: vi.fn(),
  parseStudioChatSaveInput: vi.fn(),
  saveStudioChatSessionForUser: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/studio-chat-persistence", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/studio-chat-persistence")>();
  return {
    ...actual,
    loadStudioChatSessionForUser: mocks.loadStudioChatSessionForUser,
    parseStudioChatSaveInput: mocks.parseStudioChatSaveInput,
    saveStudioChatSessionForUser: mocks.saveStudioChatSessionForUser,
  };
});

import { GET, PUT } from "./route";

const payload = {
  version: 2,
  owner: 5,
  savedAt: "2026-08-10T09:00:00.000Z",
  messages: [],
  draft: "",
  workspaceMode: "chat",
  generations: [],
};

describe("/api/studio/session", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: 5 });
    mocks.loadStudioChatSessionForUser.mockResolvedValue({
      payload,
      revision: 4,
      updatedAt: "2026-08-10T09:00:00.000Z",
    });
    mocks.parseStudioChatSaveInput.mockReturnValue({ expectedRevision: 4, payload, session: {} });
    mocks.saveStudioChatSessionForUser.mockResolvedValue({
      saved: true,
      session: { payload, revision: 5, updatedAt: "2026-08-10T09:01:00.000Z" },
    });
  });

  it("не отдаёт историю без авторизации", async () => {
    mocks.getSessionUser.mockResolvedValue(null);
    const response = await GET(new NextRequest("http://localhost/api/studio/session"));
    expect(response.status).toBe(401);
    expect(mocks.loadStudioChatSessionForUser).not.toHaveBeenCalled();
  });

  it("возвращает постоянный снимок и revision", async () => {
    const response = await GET(new NextRequest("http://localhost/api/studio/session"));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, session: payload, revision: 4 });
  });

  it("сохраняет снимок только в пространстве текущего пользователя", async () => {
    const response = await PUT(new NextRequest("http://localhost/api/studio/session", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: 4, session: payload }),
    }));
    expect(response.status).toBe(200);
    expect(mocks.parseStudioChatSaveInput).toHaveBeenCalledWith(
      expect.objectContaining({ expectedRevision: 4 }),
      5,
    );
    expect(mocks.saveStudioChatSessionForUser).toHaveBeenCalledWith(5, expect.objectContaining({ expectedRevision: 4 }));
  });

  it("возвращает свежую серверную версию при конфликте вкладок", async () => {
    mocks.saveStudioChatSessionForUser.mockResolvedValue({
      saved: false,
      current: { payload, revision: 7, updatedAt: "2026-08-10T09:02:00.000Z" },
    });
    const response = await PUT(new NextRequest("http://localhost/api/studio/session", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: 4, session: payload }),
    }));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: "revision_conflict", revision: 7 });
  });
});
