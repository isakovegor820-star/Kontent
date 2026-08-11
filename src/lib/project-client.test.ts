import { describe, expect, it } from "vitest";

import { parseClientProject, parseProjectsResponse } from "./project-client";

const project = {
  id: 7,
  name: "Судебная практика",
  timezone: "Europe/Moscow",
  role: "approver",
  version: 2,
  personal: false,
  selected: true,
  createdAt: "2026-08-11T10:00:00.000Z",
};

describe("project client parser", () => {
  it("normalizes a server-owned project list", () => {
    expect(parseProjectsResponse({ ok: true, projects: [project] })).toEqual([project]);
    expect(parseClientProject({ ...project, id: "7" })).toMatchObject({ id: 7 });
  });

  it("rejects invented roles and malformed identifiers", () => {
    expect(parseClientProject({ ...project, role: "admin" })).toBeNull();
    expect(parseProjectsResponse({ ok: true, projects: [{ ...project, id: -1 }] })).toBeNull();
  });
});
