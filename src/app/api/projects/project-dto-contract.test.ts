import { ProjectRequest } from "@/test/project-request";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseClientProject } from "@/lib/project-client";

const mocks = vi.hoisted(() => ({ current: vi.fn(), select: vi.fn(), create: vi.fn(), accept: vi.fn() }));
vi.mock("@/lib/session", () => ({ getSessionUser: async () => ({ id: 7 }) }));
vi.mock("@/lib/db", () => ({ getPool: () => ({}) }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: async () => ({ allowed: true }), clientIp: () => "127.0.0.1" }));
vi.mock("@/lib/project-context", () => ({ getSelectedProjectContext: mocks.current, selectProjectForUser: mocks.select }));
vi.mock("@/lib/project-team", async (original) => ({
  ...await original<typeof import("@/lib/project-team")>(), createProject: mocks.create, acceptProjectInvitation: mocks.accept,
}));
import { GET, PUT } from "./current/route";
import { POST as create } from "./route";
import { POST as accept } from "../project-invitations/accept/route";

const parseSelectedProjectResponse = (value: { project?: unknown }) => parseClientProject(value.project);
const context = { projectId: 23, name: "Проект Б", timezone: "Europe/Saratov", role: "owner", version: 4, personal: false };
const dto = { id: 23, name: "Проект Б", timezone: "Europe/Saratov", role: "owner", version: 4, personal: false, selected: true, createdAt: "" };
const request = (path: string, method: string, body?: unknown) => new ProjectRequest(23, `http://localhost${path}`, {
  method, headers: { origin: "http://localhost", "content-type": "application/json" },
  ...(body ? { body: JSON.stringify(body) } : {}),
});
beforeEach(() => {
  vi.clearAllMocks(); mocks.current.mockResolvedValue(context); mocks.select.mockResolvedValue(context);
  mocks.create.mockResolvedValue(dto); mocks.accept.mockResolvedValue({ projectId: 23, role: "owner" });
});
describe("project API serialization → client parser", () => {
  it("parses the actual current GET response", async () => {
    const response = await GET(request("/api/projects/current", "GET"));
    expect(parseSelectedProjectResponse(await response.json())).toEqual(dto);
  });
  it("parses the committed switch response", async () => {
    const response = await PUT(request("/api/projects/current", "PUT", { projectId: 23 }));
    expect(response.status).toBe(200);
    expect(parseSelectedProjectResponse(await response.json())).toEqual(dto);
  });
  it("uses the same project DTO after creation", async () => {
    const response = await create(request("/api/projects", "POST", { name: "Проект Б", timezone: "Europe/Saratov" }));
    expect(parseSelectedProjectResponse(await response.json())).toEqual(dto);
  });
  it("keeps invitation membership and adds the same selected context DTO", async () => {
    const response = await accept(request("/api/project-invitations/accept", "POST", { token: "a".repeat(43) }));
    const body = await response.json();
    expect(body.membership.projectId).toBe(23);
    expect(parseSelectedProjectResponse(body)).toEqual(dto);
  });
});
