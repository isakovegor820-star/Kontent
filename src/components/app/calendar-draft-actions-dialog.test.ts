import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./calendar-draft-actions-dialog.tsx", import.meta.url), "utf8");

describe("calendar draft actions dialog", () => {
  it("keeps preview, edit, delete and close actions explicit", () => {
    expect(source).toContain("Черновик публикации");
    expect(source).toContain("Редактировать черновик");
    expect(source).toContain("Удалить черновик");
    expect(source).toContain("Закрыть");
    expect(source).toContain("Текст публикации");
  });

  it("traps focus, closes with Escape and restores the card focus", () => {
    expect(source).toContain('role="dialog"');
    expect(source).toContain('aria-modal="true"');
    expect(source).toContain('event.key === "Escape"');
    expect(source).toContain('event.key !== "Tab"');
    expect(source).toContain("previous?.isConnected");
    expect(source).toContain("requestAnimationFrame(() =>");
    expect(source).toContain('sibling.setAttribute("inert", "")');
  });

  it("uses touch-sized project buttons and a mobile bottom-sheet layout", () => {
    expect(source).toContain("sm:items-center");
    expect(source).toContain("overscroll-contain");
    expect(source).toContain('variant="primary"');
    expect(source).toContain('variant="danger"');
  });
});
