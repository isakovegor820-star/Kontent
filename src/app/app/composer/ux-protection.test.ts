import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("composer UX protection contract", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "src/app/app/composer/page.tsx"), "utf8");

  it("keeps AI output separate until the user applies it and sends quick settings", () => {
    expect(source).toContain('status: "ready"');
    expect(source).toContain("Применить вариант");
    expect(source).toContain("Оставить текущий текст");
    expect(source).toContain("postSettings,");
    expect(source).toContain("<PostSettingsMenu");
  });

  it("treats every terminal AI result as ready without judging the post in the UI", () => {
    expect(source).toContain('streamState.validation = "none"');
    expect(source).not.toContain("Вариант требует правки");
    expect(source).not.toContain("Сначала исправьте факты");
    expect(source).not.toContain("Нужно исправить текст");
  });

  it("exposes the three working publication paths in one sticky action bar", () => {
    expect(source).toContain('void publish("calendar")');
    expect(source).toContain('void publish("now")');
    expect(source).toContain('void publish("queue")');
    expect(source).toContain("<ComposerActionBar />");
    expect(source).toContain("Опубликовать сейчас");
    expect(source).toContain("Поставить в очередь");
    expect(source).toContain("Добавить в календарь");
    expect(source).toContain("setPublicationSuccess({");
  });

  it("provides recovery, upload, and multi-destination controls", () => {
    expect(source).toContain("c.undoText");
    expect(source).toContain("c.redoText");
    expect(source).toContain("<RevisionHistoryPanel />");
    expect(source).toContain('fetch(`/api/drafts/${c.draftId}/revisions`');
    expect(source).toContain('accept="image/jpeg,image/png,image/webp"');
    expect(source).toContain("c.toggleChannelId(ch.id)");
    expect(source).toContain("c.toggleVkChannelId(ch.id)");
  });

  it("deletes an existing calendar draft from a visible editor action", () => {
    const actionBar = source.slice(
      source.indexOf("function ComposerActionBar"),
      source.indexOf("/* ---------------------------------------------------------------- РЕДАКТОР */"),
    );

    expect(actionBar).toContain("c.canEditContent && c.editingId");
    expect(actionBar).toContain('variant="danger"');
    expect(actionBar).toContain("c.setConfirmDelete(true)");
    expect(source).toContain("Удалить из календаря");
    expect(source).toContain("<ConfirmDialog");
    expect(source).toContain('title="Удалить черновик из календаря?"');
    expect(source).toContain('confirmLabel="Удалить из календаря"');
    expect(source).toContain("draftDeleteRequestRef");
    expect(source).toContain("await deleteServerDraft(draftId, draftVersion)");
    expect(source).toContain('router.push("/app/calendar")');
    expect(source).not.toContain("Да, удалить");
  });
});
