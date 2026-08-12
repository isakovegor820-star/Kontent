import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createHash } from "node:crypto";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  getPool: vi.fn(),
  checkRateLimit: vi.fn(),
  createProject: vi.fn(),
  createProjectInvitation: vi.fn(),
  acceptProjectInvitation: vi.fn(),
  selectProjectForUser: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/db", () => ({ getPool: mocks.getPool }));
vi.mock("@/lib/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rate-limit")>();
  return { ...actual, checkRateLimit: mocks.checkRateLimit };
});
vi.mock("@/lib/project-team", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/project-team")>();
  return {
    ...actual,
    createProject: mocks.createProject,
    createProjectInvitation: mocks.createProjectInvitation,
    acceptProjectInvitation: mocks.acceptProjectInvitation,
  };
});
vi.mock("@/lib/project-context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/project-context")>();
  return { ...actual, selectProjectForUser: mocks.selectProjectForUser };
});

import { ProjectAccessError } from "@/lib/project-permissions";
import { POST as createProject } from "./route";
import { PUT as switchProject } from "./current/route";
import { POST as createInvitation } from "./[projectId]/invitations/route";
import { POST as acceptInvitation } from "../project-invitations/accept/route";

const member = { id: 5, email: "member@example.com" };

function request(path: string, method: string, body?: unknown, headers?: Record<string, string>) {
  return new NextRequest(`https://aurora.test${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("project API routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue(member);
    mocks.getPool.mockReturnValue({});
    mocks.checkRateLimit.mockResolvedValue({ allowed: true, limit: 20, remaining: 19, retryAfter: 0 });
    mocks.createProject.mockResolvedValue({ id: 2, name: "Команда", role: "owner" });
    mocks.createProjectInvitation.mockResolvedValue({
      invitation: { id: 3, email: "new@example.com", role: "author", status: "pending" },
      token: "s".repeat(43),
    });
    mocks.acceptProjectInvitation.mockResolvedValue({ projectId: 2, role: "author" });
  });

  it("rejects a cross-site project mutation before auth and persistence", async () => {
    const response = await createProject(request("/api/projects", "POST", { name: "Команда" }, {
      origin: "https://attacker.example",
      "sec-fetch-site": "cross-site",
    }));
    expect(response.status).toBe(403);
    expect(mocks.getSessionUser).not.toHaveBeenCalled();
    expect(mocks.createProject).not.toHaveBeenCalled();
  });

  it("maps a cross-project switch denial to 403 without changing selection", async () => {
    mocks.selectProjectForUser.mockRejectedValue(new ProjectAccessError("membership_required"));
    const response = await switchProject(request("/api/projects/current", "PUT", { projectId: 999 }));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: "access_denied" });
  });

  it("fails invite creation closed when the limiter is unavailable", async () => {
    mocks.checkRateLimit.mockResolvedValue({
      allowed: false, limit: 20, remaining: 0, retryAfter: 30, unavailable: true,
    });
    const response = await createInvitation(
      request("/api/projects/2/invitations", "POST", { email: "new@example.com", role: "author" }),
      { params: Promise.resolve({ projectId: "2" }) },
    );
    expect(response.status).toBe(503);
    expect(mocks.createProjectInvitation).not.toHaveBeenCalled();
  });

  it("rejects unsupported media, unknown keys and the actual oversized stream", async () => {
    const unsupported = await createProject(new NextRequest("https://aurora.test/api/projects", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ name: "Команда" }),
    }));
    expect(unsupported.status).toBe(415);

    const unknown = await createProject(request("/api/projects", "POST", {
      name: "Команда",
      role: "owner",
    }));
    expect(unknown.status).toBe(400);

    const oversized = await createProject(new NextRequest("https://aurora.test/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "2" },
      body: JSON.stringify({ name: "x".repeat(20_000) }),
    }));
    expect(oversized.status).toBe(413);
    expect(mocks.createProject).not.toHaveBeenCalled();
  });

  it("rejects malformed UTF-8 before project persistence", async () => {
    const response = await createProject(new NextRequest("https://aurora.test/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new Uint8Array([0x7b, 0x22, 0x6e, 0x61, 0x6d, 0x65, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d]),
    }));
    expect(response.status).toBe(400);
    expect(mocks.createProject).not.toHaveBeenCalled();
  });

  it("returns the 32-byte secret only inside the one-time copyable invitation URL", async () => {
    const response = await createInvitation(
      request("/api/projects/2/invitations", "POST", { email: "new@example.com", role: "author" }),
      { params: Promise.resolve({ projectId: "2" }) },
    );
    expect(response.status).toBe(201);
    const json = await response.json();
    expect(json.token).toBeUndefined();
    expect(json.inviteUrl).toBe(`https://aurora.test/invite#token=${"s".repeat(43)}`);
    expect(mocks.checkRateLimit).toHaveBeenCalledWith(
      "project-invite:create:user:5", 20, 3600, { failureMode: "closed" },
    );
  });

  it("rate-limits acceptance fail-closed and delegates only for the authenticated user", async () => {
    const response = await acceptInvitation(request(
      "/api/project-invitations/accept",
      "POST",
      { token: "t".repeat(43) },
      { "x-real-ip": "192.0.2.1" },
    ));
    expect(response.status).toBe(200);
    const ipHash = createHash("sha256").update("192.0.2.1").digest("hex").slice(0, 32);
    expect(mocks.checkRateLimit).toHaveBeenCalledWith(
      `project-invite:accept:user:5:ip:${ipHash}`, 20, 900, { failureMode: "closed" },
    );
    expect(mocks.acceptProjectInvitation).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: 5,
      token: "t".repeat(43),
    }));
  });
});
