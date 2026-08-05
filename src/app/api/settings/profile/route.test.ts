import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  query: vi.fn(),
  connect: vi.fn(),
  release: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/db", () => ({ getPool: () => ({ query: mocks.query, connect: mocks.connect }) }));

import { GET, POST } from "./route";

function request(body?: unknown, headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost/api/settings/profile?channel=42", {
    method: body ? "POST" : "GET",
    headers: { origin: "http://localhost", "content-type": "application/json", ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
}

const validBody = {
  requestKey: "profile:save:one",
  channelId: 42,
  name: "Анна",
  avatar: "https://cdn.example.test/a.png",
  brief: {
    niche: "Право для бизнеса",
    audience: "Предприниматели",
    goal: "Консультации",
    rubrics: ["Практика"],
    formats: ["Текст", "Видео"],
    authorRole: "Юрист и автор",
    cta: "Записаться на консультацию",
    taboo: "Не гарантировать результат",
  },
};

describe("settings profile route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: 7 });
    mocks.connect.mockResolvedValue({ query: mocks.query, release: mocks.release });
  });

  it("loads account data and the existing channel content_brief", async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ name: "Анна", avatar: null, email: "a@example.test", password_hash: "hash", tg_id: null, vk_id: null }] })
      .mockResolvedValueOnce({ rows: [{ id: "42" }] })
      .mockResolvedValueOnce({ rows: [{ niche: "Право", audience: "Бизнес", rubrics: ["Практика"], formats: ["Видео"], author_role: "Юрист", cta: "В бот", taboo: "Без обещаний", ready: true, source: "manual" }] })
      .mockResolvedValueOnce({ rows: [{ target_email: "new@example.test", expires_at: "2026-08-05T14:00:00Z" }] });

    const response = await GET(request());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      account: { reauthMethod: "password" },
      pendingEmail: { email: "new@example.test" },
      channelId: 42,
      brief: { formats: ["Видео"], authorRole: "Юрист", cta: "В бот", taboo: "Без обещаний" },
    });
  });

  it("atomically updates users and content_brief and persists the idempotent result", async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql === "begin" || sql === "commit" || sql.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (sql.includes("from profile_update_operations")) return { rows: [] };
      if (sql.includes("select id from channels")) return { rows: [{ id: "42" }] };
      if (sql.includes("update users set name")) return { rows: [{ email: "a@example.test" }] };
      if (sql.includes("insert into content_brief") || sql.includes("insert into profile_update_operations")) return { rows: [], rowCount: 1 };
      throw new Error(`unexpected query: ${sql}`);
    });

    const response = await POST(request(validBody, { "idempotency-key": validBody.requestKey }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, channelId: 42 });
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes("formats = excluded.formats"))).toBe(true);
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes("taboo = excluded.taboo"))).toBe(true);
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes("profile_update_operations"))).toBe(true);
    expect(mocks.release).toHaveBeenCalled();
  });

  it("replays the same key and rejects a changed payload without updates", async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql === "begin" || sql === "rollback" || sql.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (sql.includes("from profile_update_operations")) {
        return { rows: [{ request_fingerprint: "different", result_payload: { ok: true } }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    const response = await POST(request(validBody));
    expect(response.status).toBe(409);
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes("update users"))).toBe(false);
  });

  it("rejects cross-origin mutations before opening a transaction", async () => {
    const response = await POST(request(validBody, { origin: "https://evil.example" }));
    expect(response.status).toBe(403);
    expect(mocks.connect).not.toHaveBeenCalled();
  });
});
