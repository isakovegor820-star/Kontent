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

import { PATCH, POST } from "./route";

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

  it("partially saves appearance without rewriting names, contacts, or other preferences", async () => {
    const response = await PATCH(request({ theme: "light" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, patch: { theme: "light" } });
    const updates = mocks.query.mock.calls.filter(([sql]) => String(sql).startsWith("update"));
    expect(updates).toEqual([["update user_account_settings set theme = $2, updated_at = now() where user_id = $1", [7, "light"]]]);
  });

  it("updates only the avatar when saving a picture", async () => {
    const response = await PATCH(request({ avatar: validProfile.avatar }));
    expect(response.status).toBe(200);
    const update = mocks.query.mock.calls.find(([sql]) => String(sql).startsWith("update users"));
    expect(update?.[1]).toEqual([7, false, null, true, validProfile.avatar]);
  });

  it.each([{ email: "other@example.test" }, { phone: "+123456789" }, { theme: "blue" }, { displayName: " " }, { avatar: "javascript:alert(1)" }, {}])("rejects invalid partial writes: %j", async (body) => {
    const response = await PATCH(request(body));
    expect(response.status).toBe(422);
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("checks origin and authentication for partial updates", async () => {
    expect((await PATCH(request({ theme: "dark" }, "https://evil.example"))).status).toBe(403);
    mocks.getSessionUser.mockResolvedValue(null);
    expect((await PATCH(request({ theme: "dark" }))).status).toBe(401);
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("rolls back a failed partial save", async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.startsWith("update")) throw new Error("database_failed");
      return { rows: [] };
    });
    expect((await PATCH(request({ theme: "light" }))).status).toBe(503);
    expect(mocks.query).toHaveBeenCalledWith("rollback");
    expect(mocks.release).toHaveBeenCalledOnce();
  });
});
