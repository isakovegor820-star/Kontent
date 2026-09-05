import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  hasTrustedMutationOrigin: vi.fn(),
  buildLibraryRegistrySnapshot: vi.fn(),
  query: vi.fn(),
  stored: null as null | { id: string; snapshot: Record<string, unknown> },
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/request-origin", () => ({ hasTrustedMutationOrigin: mocks.hasTrustedMutationOrigin }));
vi.mock("@/lib/library-registry", () => ({ buildLibraryRegistrySnapshot: mocks.buildLibraryRegistrySnapshot }));
vi.mock("@/lib/db", () => ({ getPool: () => ({ query: mocks.query }) }));

import { POST } from "./route";

function request(key = "library_export_123456789") {
  return new NextRequest("http://localhost/api/library/exports", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": key, origin: "http://localhost" },
    body: JSON.stringify({ filters: { channel: 11, scoreMin: 70 } }),
  });
}

const snapshot = {
  channelId: 11,
  channelTitle: "Канал",
  exportedAt: "2026-08-05T10:00:00.000Z",
  activeFilters: {},
  formulaVersion: "aurora-library-v1",
  items: [{ id: "reference:1" }],
};

describe("POST /api/library/exports", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hasTrustedMutationOrigin.mockReturnValue(true);
    mocks.getSessionUser.mockResolvedValue({ id: 7 });
    mocks.buildLibraryRegistrySnapshot.mockResolvedValue(snapshot);
    mocks.stored = null;
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("from project_members") || sql.includes("from user_project_preferences")) return { rows: [{ project_id: 23, user_id: 7, role: "owner", version: 1 }] };
      if (sql.includes("insert into library_export_snapshots")) return { rows: [{ id: "41", snapshot }] };
      return { rows: mocks.stored ? [mocks.stored] : [] };
    });
  });

  it("creates one immutable snapshot and six download links", async () => {
    const response = await POST(request());
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ ok: true, id: 41, count: 1, formats: expect.arrayContaining([{ format: "csv", href: "/api/library/exports/41?format=csv&projectId=23" }]) });
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining("insert into library_export_snapshots"),
      expect.arrayContaining([7, 11, "library_export_123456789", "aurora-library-v1"]),
    );
  });

  it("replays the same snapshot for the same idempotency key", async () => {
    mocks.stored = { id: "41", snapshot };
    const response = await POST(request());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ replay: true, id: 41 });
    expect(mocks.buildLibraryRegistrySnapshot).not.toHaveBeenCalled();
    expect(mocks.query.mock.calls.filter(([sql]) => String(sql).includes("from library_export_snapshots"))).toHaveLength(1);
    expect(mocks.query.mock.calls.filter(([sql]) => String(sql).includes("from project_members"))).toHaveLength(1);
  });

  it("returns metadata from the stored snapshot on a replay", async () => {
    mocks.stored = { id: "41", snapshot: { ...snapshot, formulaVersion: "stored-v1", items: [] } };

    const response = await POST(request());

    await expect(response.json()).resolves.toMatchObject({
      replay: true,
      formulaVersion: "stored-v1",
      count: 0,
    });
    expect(mocks.buildLibraryRegistrySnapshot).not.toHaveBeenCalled();
  });

  it("rejects weak idempotency keys before building a snapshot", async () => {
    const response = await POST(request("short"));
    expect(response.status).toBe(400);
    expect(mocks.buildLibraryRegistrySnapshot).not.toHaveBeenCalled();
  });
});
