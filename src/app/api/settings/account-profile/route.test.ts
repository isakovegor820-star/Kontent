import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  connect: vi.fn(),
  query: vi.fn(),
  release: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/db", () => ({ getPool: () => ({ connect: mocks.connect }) }));

import { POST } from "./route";

function request(body: Record<string, unknown>, origin = "http://localhost") {
  return new NextRequest("http://localhost/api/settings/account-profile", {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify(body),
  });
}

const validProfile = {
  firstName: "Егор",
  lastName: "Авроров",
  displayName: "Егор",
  jobTitle: "Автор",
  bio: "Пишу о технологиях и праве.",
  avatar: "/api/settings/profile/avatar-assets/91",
  locale: "ru",
  timezone: "Europe/Saratov",
  theme: "system",
};

describe("POST /api/settings/account-profile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: 7, name: "Старое имя" });
    mocks.connect.mockResolvedValue({ query: mocks.query, release: mocks.release });
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("update users")) return { rows: [{ email: "egor@example.com", avatar: validProfile.avatar }] };
      return { rows: [], rowCount: 1 };
    });
  });

  it("saves account fields and the shell identity in one transaction", async () => {
    const response = await POST(request(validProfile));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      profile: { displayName: "Егор", timezone: "Europe/Saratov", theme: "system" },
    });
    expect(mocks.query.mock.calls.map(([sql]) => String(sql).trim())).toEqual([
      "begin",
      expect.stringContaining("insert into user_account_settings"),
      expect.stringContaining("update users set name"),
      "commit",
    ]);
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it("rejects an untrusted origin and an invalid timezone before a transaction", async () => {
    const forbidden = await POST(request(validProfile, "https://evil.example"));
    expect(forbidden.status).toBe(403);

    const invalid = await POST(request({ ...validProfile, timezone: "Mars/Olympus" }));
    expect(invalid.status).toBe(422);
    await expect(invalid.json()).resolves.toMatchObject({ error: "bad_timezone" });
    expect(mocks.connect).not.toHaveBeenCalled();
  });
});
