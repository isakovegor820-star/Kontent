import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  query: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/db", () => ({ getPool: () => ({ query: mocks.query }) }));

import { POST } from "./route";

function automaticSettingsRequest() {
  return new NextRequest("http://localhost/api/settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ postSettings: { version: 1 } }),
  });
}

describe("POST /api/settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: 7 });
    mocks.query.mockResolvedValue({ rowCount: 1, rows: [] });
  });

  it("persists an identical automatic profile on every explicit save", async () => {
    const first = await POST(automaticSettingsRequest());
    const second = await POST(automaticSettingsRequest());

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect((await first.json()).postSettings).toMatchObject({ version: 1, target: "auto", preset: "auto" });
    expect((await second.json()).postSettings).toMatchObject({ version: 1, target: "auto", preset: "auto" });
    expect(mocks.query).toHaveBeenCalledTimes(2);
    expect(mocks.query.mock.calls.map((call) => call[1]?.[4])).toEqual([
      JSON.stringify({ version: 1 }),
      JSON.stringify({ version: 1 }),
    ]);
  });
});
