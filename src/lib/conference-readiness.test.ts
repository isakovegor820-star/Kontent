import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { emptyState } from "./mock";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("conference readiness UI contracts", () => {
  it("starts real workspaces without the coffee demo fixture", () => {
    const state = emptyState();
    expect(state).toMatchObject({
      channels: [], posts: [], competitors: [], trends: [], autopilot: [],
      settings: { botLinked: false, aiUsedToday: 0, niche: "", tone: "" },
    });
    const store = source("./store.tsx");
    expect(store).toContain('import { emptyState } from "./mock"');
    expect(store).not.toContain("seedState(");
  });

  it("does not present an empty or personal draft as platform-approved", () => {
    const composer = source("../app/app/composer/page.tsx");
    expect(composer).toContain("const hasContent = c.text.trim().length > 0");
    expect(composer).toContain('"Черновик не заполнен"');
    expect(composer).toContain('"Готово к решению владельца"');
    expect(composer).toContain("disabled={publicationUnavailable}");
  });

  it("prevents the sole-owner controls and explains the invariant", () => {
    const team = source("../components/app/project-team-section.tsx");
    expect(team).toContain('const soleOwner = member.role === "owner" && ownerCount === 1');
    expect(team).toContain("Сначала назначьте второго владельца проекта");
    expect(team).toContain("disabled={Boolean(savingKey) || soleOwner}");
  });

  it("keeps the repeated accessibility fixes in the rendered sources", () => {
    const toaster = source("../components/ui/toaster.tsx");
    const calendar = source("../app/app/calendar/page.tsx");
    const shell = source("../components/app/shell.tsx");
    expect(toaster).toMatch(/role="region"\s+aria-label="Уведомления"/u);
    expect(calendar).toContain('<dd className="contents">');
    expect(shell).toContain('aria-controls={menuOpen ? "app-drawer" : undefined}');
  });

  it("marks landing metrics as a demo and retains stronger contrast values", () => {
    const scene = source("../components/landing/hero-product-scene.tsx");
    const css = source("../components/landing/reference-landing.module.css");
    expect(scene).toContain("Демонстрационный пример");
    expect(css).toContain(".productSceneLabel");
    expect(css).toContain(".vkIcon { background: #1769c2; }");
    expect(css.match(/color: #667085;/gu)?.length).toBeGreaterThanOrEqual(2);
  });
});
