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

  it("bounds AI streams and safely seeds a requested daily suggestion", () => {
    expect(source).toContain("readAiStreamWithDeadline({");
    expect(source).toContain("idleTimeoutMs: AI_CLIENT_IDLE_TIMEOUT_MS");
    expect(source).toContain("overallTimeoutMs: AI_CLIENT_OVERALL_TIMEOUT_MS");
    expect(source).toContain("error instanceof AiClientStreamTimeoutError");
    expect(source).toContain("Исходный текст и готовая часть сохранены");
    expect(source).toContain('params.get("idea")?.trim().slice(0, 1_000)');
    expect(source).toContain('params.get("assistant") === "script"');
    expect(source).toContain("seededSuggestionRef.current === ideaParam");
  });

  it("exposes three publication paths without covering the mobile editor", () => {
    expect(source).toContain('void publish("calendar")');
    expect(source).toContain('void publish("now")');
    expect(source).toContain('void publish("queue")');
    expect(source).toContain("<ComposerActionBar />");
    expect(source).toContain("Опубликовать сейчас");
    expect(source).toContain("Поставить в очередь");
    expect(source).toContain("Добавить в календарь");
    expect(source).toContain("setPublicationSuccess({");
    expect(source).toContain("--composer-action-bar-clearance");
    expect(source).toContain("root.style.scrollPaddingBottom = clearance");
    expect(source).toContain('className="relative z-10 mt-4 lg:fixed');
    expect(source).toContain('className="hidden h-[var(--composer-action-bar-clearance,18rem)] lg:block"');
    expect(source).toContain('window.matchMedia("(min-width: 1024px)")');
    expect(source).toContain("Другие действия");
    expect(source).toContain('className="hidden flex-wrap gap-2 sm:flex"');
    expect(source).toContain("new ResizeObserver(updateClearance)");
    expect(source).toContain("scroll-mb-72");
  });

  it("edits calendar publications without reopening the removed management modal", () => {
    expect(source).toContain('params.get("publication")');
    expect(source).toContain("getPublicationOperationEditorContext(publicationParam");
    expect(source).toContain("Обновить публикацию");
    expect(source).toContain("Запланировать снова");
    expect(source).toContain("Отменить запланированную публикацию?");
    expect(source).toContain("publicationOperationIsSettled(activePublication)");
    expect(source).toContain("await cancelPublication({");
    expect(source).toContain("await reschedulePublication({");
    expect(source).toContain("Старая публикация остановлена, новая ещё не создана");
    expect(source).toContain("publicationOperationReachedCalendar(result)");
    expect(source).toContain("Изменённый пост сохранён в календаре");
    expect(source).toContain("<PublicationFollowupSection");
  });

  it("bounds stalled AI streams and opens daily calendar ideas in the requested mode", () => {
    expect(source).toContain("readAiStreamWithDeadline");
    expect(source).toContain("AI_CLIENT_IDLE_TIMEOUT_MS");
    expect(source).toContain("Генерация остановлена по тайм-ауту");
    expect(source).toContain('params.get("idea")');
    expect(source).toContain('params.get("assistant") === "script"');
    expect(source).toContain('c.runAi(suggestedCommand)');
  });

  it("provides recovery, upload, and multi-destination controls", () => {
    expect(source).toContain("c.undoText");
    expect(source).toContain("c.redoText");
    expect(source).toContain("<RevisionHistoryPanel />");
    expect(source).toContain('fetch(`/api/drafts/${c.draftId}/revisions`');
    expect(source).toContain('accept="image/jpeg,image/png,image/webp"');
    expect(source).toContain("c.toggleChannelId(ch.id)");
    expect(source).toContain("c.toggleVkChannelId(ch.id)");
    expect(source).toContain("recoverServerDraft(draftId, recovery)");
    expect(source).toContain("runSingleDraftSave(");
    expect(source).toContain("recoveryRequestRef,");
    expect(source).toContain("Создать новый пост из текста");
    expect(source).toContain("Создать пост из материала");
    expect(source).toContain("acceptResponsibility: true");
    expect(source).toContain("Исходная версия сохранена отдельно");
    expect(source).toContain('href="/app/settings?section=channels"');
    expect(source).toContain("destination-less safe copy");
  });

  it("creates media inside the editor instead of navigating to a hidden experimental page", () => {
    expect(source).toContain("<MediaGenerator");
    expect(source).toContain('id="composer-media-generator"');
    expect(source).toContain("onUse={useGeneratedMedia}");
    expect(source).toContain('title: "Медиа добавлено к посту"');
    expect(source).not.toContain("/app/studio/visuals?draft=");
    expect(source).not.toContain("EXPERIMENTAL_ROUTES_ENABLED");
  });

  it("replaces guaranteed-failure publication actions with one inline recovery action", () => {
    const actionBar = source.slice(
      source.indexOf("function ComposerActionBar"),
      source.indexOf("/* ---------------------------------------------------------------- РЕДАКТОР */"),
    );
    expect(actionBar).toContain("const blocked = c.blockedReason");
    expect(actionBar).not.toContain('c.blockedReason === "validation_blocked"');
    expect(actionBar).toContain("c.canRecoverDraft");
    expect(actionBar).toContain("void c.recoverDraft()");
    expect(actionBar).toContain("c.canEditContent && c.editingId");
    expect(actionBar).toContain("c.setConfirmDelete(true)");
    expect(actionBar).toContain('aria-live="polite"');
    expect(source).not.toContain("Принять и создать пост");
    expect(source).not.toContain("personalResponsibilityTakeover");
    expect(source).toContain("if (blockedReason != null) return;");
    expect(source).not.toContain("Пересохраните старую версию");
    expect(source).not.toContain("Эта версия не привязана к завершённой генерации");
    expect(source).not.toContain("Проверка нашла неподтверждённые утверждения");
  });

  it("owns local validation inline and focuses the contenteditable root", () => {
    expect(source).toContain('current.textCode === "empty"');
    expect(source).toContain("[contenteditable='true']");
    expect(source).toContain("prefers-reduced-motion: reduce");
    expect(source).not.toContain('title: "Нужно заполнить данные"');
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
    expect(source).toContain("await draftRequestRef.current?.catch(() => null)");
    expect(source).toContain("await deleteServerDraft(currentDraftId, currentDraftVersion)");
    expect(source).toContain('router.push("/app/calendar")');
    expect(source).not.toContain("Да, удалить");
  });
});
