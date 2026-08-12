import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireSelectedProjectPermission: vi.fn(),
}));

vi.mock("@/lib/project-permissions", async (original) => ({
  ...await original<typeof import("@/lib/project-permissions")>(),
  requireSelectedProjectPermission: mocks.requireSelectedProjectPermission,
}));

import {
  authorizePublicationOperation,
  PublicationOperationNotFoundError,
} from "./_project-authorization";

describe("publication operation project authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireSelectedProjectPermission.mockResolvedValue({
      projectId: 23,
      userId: 5,
      role: "publisher",
      version: 1,
    });
  });

  it("scopes a readable operation to the server-owned selected project", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: "7" }] });

    await expect(authorizePublicationOperation({
      db: { query } as never,
      userId: 5,
      operationId: 7,
      permission: "project.read",
    })).resolves.toEqual({ projectId: 23 });

    expect(mocks.requireSelectedProjectPermission).toHaveBeenCalledWith(
      expect.objectContaining({ query }),
      5,
      "project.read",
    );
    expect(String(query.mock.calls[0]?.[0])).toContain("project_id = $2");
    expect(query.mock.calls[0]?.[1]).toEqual([7, 23, null]);
  });

  it("retains the creator fence for lifecycle mutations", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: "7" }] });

    await authorizePublicationOperation({
      db: { query } as never,
      userId: 5,
      operationId: 7,
      permission: "content.publish",
      requireCreator: true,
    });

    expect(query.mock.calls[0]?.[1]).toEqual([7, 23, 5]);
  });

  it("does not reveal an operation from a different project", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });

    await expect(authorizePublicationOperation({
      db: { query } as never,
      userId: 5,
      operationId: 99,
      permission: "content.publish",
      requireCreator: true,
    })).rejects.toBeInstanceOf(PublicationOperationNotFoundError);
  });
});
