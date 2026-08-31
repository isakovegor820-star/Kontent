import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

function section(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

describe("publisher scheduling overlay contract", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "src/app/app/composer/page.tsx"),
    "utf8",
  );

  it("keeps team approval strict while making personal scheduling one action", () => {
    expect(source).toContain('const roleCanEditContent = projectRole != null && projectRole !== "publisher";');
    expect(source).toContain('const canEditContent = roleCanEditContent');
    expect(source).toContain('&& blockedReason !== "source_context_not_publishable"');
    expect(source).toContain('const canPublish = projectRole === "owner" || projectRole === "publisher";');
    expect(source).toContain('const scheduleIsPublicationOverlay = canPublish && editorialState === "approved";');

    const persist = section(source, "const persistDraft = useCallback", "const saveDraft = useCallback");
    expect(persist).toContain("if (!canEditContent) return Promise.resolve(null);");

    const remove = section(source, "const removeCurrent = useCallback", "const value = useMemo");
    expect(remove).toContain("if (!canEditContent || !editingId) return;");

    const publish = section(source, "const publish = useCallback", "const removeCurrent = useCallback");
    expect(publish).toContain('if (!personalProject && editorialState !== "approved")');
    expect(publish).toContain('? await persistDraft("schedule", scheduleOverlay)');
    expect(publish).toContain(": acknowledgedDraftRef.current;");
    expect(publish).toContain("await approvePersonalDraftForPublication(draft.id, draft.version)");
    expect(publish).toContain("await s.createPublicationOperation");
    expect(publish).toContain("publicationOperationReachedCalendar(result)");
    expect(publish).toContain('const queued = result.ok && result.operationStatus === "queued";');
    expect(publish).not.toContain("result.destinations?.length === draft.destinations.length");
    expect(publish).toContain('router.push("/app/calendar")');
    expect(publish).toContain("setPublicationSuccess({");
    expect(publish).not.toContain("updateServerDraft(");
    expect(publish).not.toContain("deleteServerDraft(");

    expect(source).toContain('&& editorialState !== "approved"');
    expect(source).toContain("&& !personalProject");
    expect(source).toContain("if (needWhen && blockedReason)");

    expect(publish).toContain("publicationOperationRef.current ??=");
    expect(publish).toContain("if (result.fingerprint) operation.fingerprint = result.fingerprint;");
    const success = section(
      publish,
      "if (publicationOperationReachedCalendar(result))",
      "} else {",
    );
    expect(success.indexOf('router.push("/app/calendar")'))
      .toBeLessThan(success.indexOf("removePendingDraft"));
    const failureStart = publish.indexOf("} else {", publish.indexOf("if (publicationOperationReachedCalendar(result))"));
    const failure = publish.slice(failureStart, publish.indexOf("} finally {", failureStart));
    expect(failure).not.toContain("publicationOperationRef.current = null");

    for (const mutation of [
      section(source, "const changeDate = useCallback", "const changeTime = useCallback"),
      section(source, "const changeTime = useCallback", "const changeTimeDisambiguation = useCallback"),
      section(source, "const changeTimeDisambiguation = useCallback", "const changeNoDate = useCallback"),
      section(source, "const quick = useCallback", "/* ------------------------------------------------------------- СОХРАНЕНИЕ */"),
    ]) {
      expect(mutation).toContain("publicationOperationRef.current = null");
    }

    expect(source).toContain('className="flex flex-wrap gap-2"');
    expect(source).toContain('aria-label="Дата публикации"');
    expect(source).toContain('aria-label="Время публикации"');
    expect(source).toContain('className="flex min-h-11 cursor-pointer items-center');
  });

  it("does not replay an already-bound generation result after hydration", () => {
    const hydrate = section(source, "const hydrate = useCallback", "const beginHydration = useCallback");
    expect(hydrate).toContain("pending.payload.generationResultId !== draft?.generation_result_id");
    expect(hydrate).not.toContain("draft?.generation_binding_valid ? draft.generation_result_id");
  });

  it("persists editor formatting and explains the VK limitation", () => {
    const persist = section(source, "const persistDraft = useCallback", "const saveDraft = useCallback");
    expect(persist).toMatch(/const common = \{\s*text,\s*formatting,/);

    const dependencies = persist.slice(persist.lastIndexOf("[\n      canEditContent,"));
    expect(dependencies).toContain("\n      formatting,");

    expect(source).toContain("Форматирование применится в Telegram. VK опубликует обычный текст.");
    expect(source).toContain("один текст, оформление — только для Telegram");
  });

  it("keeps removed advanced panels out of the composer", () => {
    for (const removed of [
      "Семантическая проверка недоступна",
      "Я проверил(а) факты",
      "Типограф и словарь",
      "Скачать пакет TenChat",
      "<TenChatExportCard",
      "<TrackingBuilder",
      "<PublicationSettingsPanel",
      "<TypographerPanel",
    ]) {
      expect(source).not.toContain(removed);
    }
  });
});
