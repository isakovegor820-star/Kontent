import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("post settings automatic selection contract", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "src/components/studio/post-settings-menu.tsx"),
    "utf8",
  );

  it("applies the complete automatic profile in one click and exposes its saved state", () => {
    expect(source).toContain("const next = automaticPostSettings();");
    expect(source).toContain("setDraft(next);");
    expect(source).toContain("onChange(next);");
    expect(source).toContain("postSettingsAreAutomatic(settings)");
    expect(source).toContain("Выбрано автоматически");
    expect(source).toContain('role="status"');
    expect(source).toContain("ручные ограничения очищены");
  });

  it("exposes the focus-trapped settings panel as a modal to assistive technology", () => {
    expect(source).toContain('role="dialog"');
    expect(source).toContain('aria-modal="true"');
  });
});
