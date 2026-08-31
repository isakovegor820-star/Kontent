import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("post settings automatic selection contract", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "src/components/studio/post-settings-menu.tsx"),
    "utf8",
  );

  it("prepares a fresh automatic profile on every click and keeps saving explicit", () => {
    expect(source).toContain("const next = automaticPostSettings();");
    expect(source).toContain("setDraft(next);");
    expect(source).toContain("setAutomaticSelectionPending(true);");
    expect(source).toContain("dirty || automaticSelectionPending");
    expect(source).toContain("disabled={!hasPendingChanges || saving}");
    expect(source).toContain("postSettingsAreAutomatic(settings)");
    expect(source).toContain("Подобрать заново");
    expect(source).toContain("Автоподбор готов");
    expect(source).toContain('role="status"');
    expect(source).toContain("Нажми «Сохранить настройки»");
  });

  it("offers the same automatic selection in quick and advanced modes", () => {
    expect(source).toContain("Автоподбор всех расширенных настроек");
    expect(source).toContain("advanced");
    expect(source.match(/onSelect=\{useAutomaticQuickSettings\}/gu)).toHaveLength(2);
  });

  it("exposes the focus-trapped settings panel as a modal to assistive technology", () => {
    expect(source).toContain('role="dialog"');
    expect(source).toContain('aria-modal="true"');
  });
});
