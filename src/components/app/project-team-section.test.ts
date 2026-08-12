import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  parseProjectInvitations,
  parseProjectMembers,
  projectTeamErrorMessage,
} from "./project-team-section";

describe("ProjectTeamSection contracts", () => {
  it("parses only complete server-owned team records", () => {
    expect(parseProjectMembers({
      ok: true,
      members: [{
        userId: 4,
        name: "Анна",
        email: "anna@example.ru",
        avatar: null,
        role: "approver",
        version: 3,
        joinedAt: "2026-08-11T10:00:00.000Z",
      }],
    })).toHaveLength(1);
    expect(parseProjectMembers({ ok: true, members: [{ userId: 4, role: "admin" }] })).toBeNull();

    expect(parseProjectInvitations({
      ok: true,
      invitations: [{
        id: 8,
        email: "author@example.ru",
        role: "author",
        status: "pending",
        expiresAt: "2026-08-18T10:00:00.000Z",
        createdAt: "2026-08-11T10:00:00.000Z",
        acceptedAt: null,
        revokedAt: null,
      }],
    })).toHaveLength(1);
  });

  it("gives actionable conflict and last-owner recovery copy", () => {
    expect(projectTeamErrorMessage("version_conflict")).toContain("Список обновлён");
    expect(projectTeamErrorMessage("last_owner")).toContain("назначь владельцем другого участника");
    expect(projectTeamErrorMessage("network")).toContain("Проверь подключение");
  });

  it("keeps forms and controls semantic, labelled and mobile-safe", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src/components/app/project-team-section.tsx"), "utf8");
    expect(source).toContain("<form noValidate");
    expect(source).toContain("<select");
    expect(source).toContain("aria-invalid=");
    expect(source).toContain("aria-describedby=");
    expect(source).toContain('role="status"');
    expect(source).toContain('role="alert"');
    expect(source).toContain("min-h-11");
    expect(source).toContain("break-words");
    expect(source).not.toContain("transition-all");
  });
});
