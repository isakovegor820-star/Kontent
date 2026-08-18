import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  hasAuroraAdminAccess: vi.fn(),
  repairAdminTelegramConfiguration: vi.fn(),
  sendAdminBotTest: vi.fn(),
  setAdminBotAccess: vi.fn(),
  setAdminBusinessAssistant: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/admin-access", () => ({ hasAuroraAdminAccess: mocks.hasAuroraAdminAccess }));
vi.mock("@/lib/admin-bot", () => ({
  repairAdminTelegramConfiguration: mocks.repairAdminTelegramConfiguration,
  sendAdminBotTest: mocks.sendAdminBotTest,
  setAdminBotAccess: mocks.setAdminBotAccess,
  setAdminBusinessAssistant: mocks.setAdminBusinessAssistant,
}));
vi.mock("@/lib/db", () => ({ getPool: () => ({ query: vi.fn(), connect: vi.fn() }) }));

import { POST } from "./route";

function request(body: unknown) {
  return new NextRequest("http://localhost/api/admin/bot/actions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/admin/bot/actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: 3, email: "admin@example.com" });
    mocks.hasAuroraAdminAccess.mockReturnValue(true);
  });

  it("does not expose actions to a regular account", async () => {
    mocks.hasAuroraAdminAccess.mockReturnValue(false);
    const response = await POST(request({ action: "test_delivery", targetUserId: 5 }));
    expect(response.status).toBe(403);
    expect(mocks.sendAdminBotTest).not.toHaveBeenCalled();
  });

  it("sends a test only to a validated positive user id", async () => {
    mocks.sendAdminBotTest.mockResolvedValue({ status: "delivered" });
    const response = await POST(request({ action: "test_delivery", targetUserId: 5 }));
    expect(response.status).toBe(200);
    expect(mocks.sendAdminBotTest).toHaveBeenCalledWith(expect.anything(), { actorUserId: 3, targetUserId: 5 });
    const invalid = await POST(request({ action: "test_delivery", targetUserId: "nope" }));
    expect(invalid.status).toBe(400);
  });

  it("repairs the long-polling Telegram configuration without dropping pending updates", async () => {
    mocks.repairAdminTelegramConfiguration.mockResolvedValue({ status: "repaired" });
    const response = await POST(request({ action: "repair_telegram_configuration" }));
    expect(response.status).toBe(200);
    expect(mocks.repairAdminTelegramConfiguration).toHaveBeenCalledWith(expect.anything(), { actorUserId: 3 });
  });

  it("applies reversible bot-only access changes", async () => {
    mocks.setAdminBotAccess.mockResolvedValue({ status: "updated", enabled: false });
    const response = await POST(request({
      action: "set_access",
      targetType: "project",
      targetId: 9,
      enabled: false,
      reason: "Проверка администратора",
    }));
    expect(response.status).toBe(200);
    expect(mocks.setAdminBotAccess).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      actorUserId: 3,
      targetType: "project",
      targetId: 9,
      enabled: false,
    }));
  });

  it("refuses to enable Business before Telegram created a connection", async () => {
    mocks.setAdminBusinessAssistant.mockResolvedValue({ status: "not_connected" });
    const response = await POST(request({ action: "set_business", projectId: 9, enabled: true }));
    expect(response.status).toBe(409);
  });
});
