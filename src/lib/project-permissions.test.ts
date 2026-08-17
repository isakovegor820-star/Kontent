import { describe, expect, it, vi } from "vitest";

import {
  ProjectAccessError,
  requireProjectPermission,
  requireSelectedProjectPermission,
  roleAllows,
} from "./project-permissions";

describe("project role permissions", () => {
  it("keeps approval and publication separated for non-owner roles", () => {
    expect(roleAllows("author", "content.edit")).toBe(true);
    expect(roleAllows("author", "content.approve")).toBe(false);
    expect(roleAllows("approver", "content.approve")).toBe(true);
    expect(roleAllows("approver", "content.publish")).toBe(false);
    expect(roleAllows("approver", "audience.reply.send")).toBe(true);
    expect(roleAllows("publisher", "content.publish")).toBe(true);
    expect(roleAllows("publisher", "audience.reply.send")).toBe(true);
    expect(roleAllows("publisher", "content.approve")).toBe(false);
    expect(roleAllows("author", "audience.reply.send")).toBe(false);
    expect(roleAllows("owner", "members.manage")).toBe(true);
  });

  it("rechecks the active membership in PostgreSQL for every authorization", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{ project_id: "12", user_id: "7", role: "author", version: "3" }],
    });
    const db = { query } as never;

    await expect(requireProjectPermission(db, 7, 12, "content.edit")).resolves.toEqual({
      projectId: 12,
      userId: 7,
      role: "author",
      version: 3,
    });
    await expect(requireProjectPermission(db, 7, 12, "content.publish")).rejects.toMatchObject({
      code: "permission_denied",
    });
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0][1]).toEqual([12, 7]);
  });

  it("uses only server-owned selection for ordinary route authorization", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{ project_id: "22", user_id: "7", role: "publisher", version: "1" }],
    });

    await expect(requireSelectedProjectPermission(
      { query } as never,
      7,
      "content.publish",
    )).resolves.toMatchObject({ projectId: 22, role: "publisher" });
    expect(query.mock.calls[0][1]).toEqual([7]);
    expect(String(query.mock.calls[0][0])).toContain("user_project_preferences");
  });

  it("fails closed for an invalid selector or missing membership", async () => {
    await expect(requireProjectPermission(
      { query: vi.fn() } as never,
      7,
      0,
      "project.read",
    )).rejects.toBeInstanceOf(ProjectAccessError);
    await expect(requireProjectPermission(
      { query: vi.fn().mockResolvedValue({ rows: [] }) } as never,
      7,
      99,
      "project.read",
    )).rejects.toMatchObject({ code: "membership_required" });
  });
});
