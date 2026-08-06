import { describe, expect, it } from "vitest";
import {
  analyzeLibraryHit,
  buildLibraryAdaptation,
  buildLibraryDraftContext,
  normalizeLibraryLabels,
  normalizeLibraryTags,
} from "./library";

describe("library helpers", () => {
  it("нормализует, очищает и дедуплицирует хэштеги", () => {
    expect(normalizeLibraryTags("#Право, право  AI_2026! #суд")).toEqual([
      "#Право",
      "#AI_2026",
      "#суд",
    ]);
  });

  it("оставляет внутренние метки без решётки", () => {
    expect(normalizeLibraryLabels("#Кейс, кейс; сильный хук")).toEqual(["Кейс", "сильный хук"]);
  });

  it("разбирает только наблюдаемые свойства хита", () => {
    expect(analyzeLibraryHit({
      text: "5 ошибок в договоре?\n\nЯ вижу их каждую неделю.\n\n1. Нет срока.\n2. Нет ответственности.",
      media: "video",
      hitRatio: 6.2,
    })).toEqual({
      hook: "5 ошибок в договоре?",
      format: "Видео + текст",
      signals: [
        "Результат ×6.2 к норме автора",
        "Начинается с вопроса",
        "В хуке есть конкретика",
        "Короткий первый экран",
        "Личная подача",
      ],
    });
  });

  it("не смешивает факты референса с заданием на новый пост", () => {
    const adaptation = buildLibraryAdaptation({
      channelName: "Технологии Права",
      source: "Конкурент",
      text: "15 сентября откроется реестр из 136 источников.",
    });

    expect(adaptation.prompt).toContain("строго по теме");
    expect(adaptation.prompt).toContain("откроется реестр из источников");
    expect(adaptation.prompt).not.toContain("15 сентября");
    expect(adaptation.prompt).not.toContain("136");
    expect(adaptation.referenceText).toBe("15 сентября откроется реестр из 136 источников.");
    expect(adaptation.referenceSource).toBe("Конкурент");
  });

  it("сохраняет текст, канал и provenance в теле серверного черновика", () => {
    const input = buildLibraryDraftContext({
      text: "Полный текст референса, который не должен попасть в URL",
      channelId: 17,
      clientKey: "draft_library-reference-1234567890",
      reference: { sourcePostId: 9, sourceLabel: "  Канал конкурента  " },
    });

    expect(input).toEqual({
      text: "Полный текст референса, который не должен попасть в URL",
      media: null,
      scheduledAt: null,
      origin: "competitor",
      sourceRef: {
        kind: "competitor",
        id: "9",
        label: "Канал конкурента",
        provenance: { kind: "competitor_post", id: "9", label: "Канал конкурента" },
      },
      channelIds: [17],
      aiValidation: null,
      clientKey: "draft_library-reference-1234567890",
    });
  });

  it("сохраняет карточку idea как idea, а источник — только как provenance", () => {
    const input = buildLibraryDraftContext({
      text: "Ошибки в договоре поставки\n\nХук\n\nСтруктура",
      channelId: 17,
      clientKey: "draft_library-idea-1234567890",
      material: {
        kind: "idea",
        id: 81,
        sourceLabel: "Идея Авроры",
        provenanceLabel: "Открытый источник",
        sourceId: 9,
        sourceUrl: "https://t.me/source/15",
        topic: "Ошибки в договоре поставки",
        hook: "Хук",
        structure: "Структура",
        whyItWorked: "Понятная проблема",
      },
    });

    expect(input.origin).toBe("idea");
    expect(input.sourceRef).toMatchObject({
      kind: "idea",
      id: "81",
      topic: "Ошибки в договоре поставки",
      hook: "Хук",
      structure: "Структура",
      whyItWorked: "Понятная проблема",
      provenance: { kind: "content_idea", id: "9", label: "Открытый источник" },
    });
    expect(input.sourceRef?.kind).not.toBe("competitor");
  });
});
