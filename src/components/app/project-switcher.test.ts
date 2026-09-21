import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { ClientProject } from "@/lib/project-client";
import { ProjectSwitcherView } from "./project-switcher";

const project: ClientProject = {
  id: 7,
  name: "Очень длинное название юридической практики Северо-Западного офиса",
  timezone: "Europe/Moscow",
  role: "approver",
  version: 1,
  personal: false,
  selected: true,
  createdAt: "2026-08-11T10:00:00.000Z",
};

describe("ProjectSwitcherView", () => {
  it("uses a labelled native selector and exposes the current role", () => {
    const html = renderToStaticMarkup(createElement(ProjectSwitcherView, {
      projects: [project],
      current: project,
      ready: true,
      error: false,
      switching: false,
      onSelect: vi.fn(),
      onRetry: vi.fn(),
    }));
    expect(html).toContain("<label");
    expect(html).toContain("<select");
    expect(html).toContain("Текущий проект");
    expect(html).toContain("Согласующий");
    expect(html).toContain("Очень длинное название");
  });

  it("keeps a compact retry action available on mobile failure", () => {
    const html = renderToStaticMarkup(createElement(ProjectSwitcherView, {
      projects: [],
      current: null,
      ready: true,
      error: true,
      switching: false,
      compact: true,
      onSelect: vi.fn(),
      onRetry: vi.fn(),
    }));
    expect(html).toContain("Повторить загрузку проектов");
    expect(html).toContain("<button");
  });
});
