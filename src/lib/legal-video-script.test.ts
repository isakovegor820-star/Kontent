import { describe, expect, it } from "vitest";

import {
  LEGAL_VIDEO_DURATIONS,
  LegalVideoValidationError,
  createLegalVideoScript,
  exportLegalVideoProductionBrief,
  legalVideoDraftContentHash,
  reviseLegalVideoScript,
  validateLegalVideoScript,
  type LegalVideoDuration,
  type LegalVideoSceneInput,
  type LegalVideoScriptInput,
} from "./legal-video-script";

const sourceBody = [
  "С 15 сентября 2026 года срок ответа составляет 10 дней.",
  "Неустойка составляет 10 процентов, но не более 100 000 рублей.",
  "Согласно ст. 446 ГПК РФ правило применяется с учётом обстоятельств дела № А40-12345/2026.",
  "Проверьте условия договора и сохраните памятку.",
].join("\n");

function durationsFor(total: LegalVideoDuration) {
  if (total === 30) return [5, 20, 5] as const;
  if (total === 45) return [7, 30, 8] as const;
  return [10, 40, 10] as const;
}

function scenesFor(total: LegalVideoDuration): LegalVideoSceneInput[] {
  const [hook, body, cta] = durationsFor(total);
  return [
    {
      id: "hook",
      order: 1,
      role: "hook",
      durationSeconds: hook,
      voiceOver: "С 15 сентября 2026 года изменился срок ответа.",
      onScreenText: "Срок ответа изменился",
      visualDirection: "Юрист открывает договор; крупный план документа.",
      sourceClaimIds: ["deadline"],
    },
    {
      id: "explanation",
      order: 2,
      role: "body",
      durationSeconds: body,
      voiceOver: "Срок составляет 10 дней. Неустойка — 10 процентов, но не более 100 000 рублей. Оговорка следует из ст. 446 ГПК РФ и материалов дела № А40-12345/2026.",
      onScreenText: "10 дней · 10 процентов · до 100 000 рублей",
      visualDirection: "Документы и нейтральная инфографика без изображения участников дела.",
      sourceClaimIds: ["deadline", "amount", "legal-reference"],
    },
    {
      id: "cta",
      order: 3,
      role: "cta",
      durationSeconds: cta,
      voiceOver: "Проверьте условия договора и сохраните памятку.",
      onScreenText: "Сохранить памятку",
      visualDirection: "Финальный экран с логотипом и спокойным призывом к действию.",
      sourceClaimIds: [],
    },
  ];
}

function inputFor(durationSeconds: LegalVideoDuration = 30): LegalVideoScriptInput {
  const contentHash = legalVideoDraftContentHash(sourceBody);
  return {
    id: "video-contract-deadline",
    projectId: 17,
    revision: 1,
    title: "Как проверить срок ответа по договору",
    durationSeconds,
    sourceDraft: {
      id: 42,
      revision: 7,
      contentHash,
      title: "Срок ответа и неустойка",
      body: sourceBody,
    },
    sourceEvidence: [
      {
        id: "deadline",
        label: "Дата и срок",
        claim: "С 15 сентября 2026 года срок ответа составляет 10 дней.",
        excerpt: "С 15 сентября 2026 года срок ответа составляет 10 дней.",
        source: { kind: "draft", draftId: 42, draftRevision: 7, draftContentHash: contentHash },
      },
      {
        id: "amount",
        label: "Размер неустойки",
        claim: "Неустойка составляет 10 процентов, но не более 100 000 рублей.",
        excerpt: "Неустойка составляет 10 процентов, но не более 100 000 рублей.",
        source: { kind: "draft", draftId: 42, draftRevision: 7, draftContentHash: contentHash },
      },
      {
        id: "legal-reference",
        label: "Правовая оговорка",
        claim: "Ст. 446 ГПК РФ и дело № А40-12345/2026.",
        excerpt: "Согласно ст. 446 ГПК РФ правило применяется с учётом обстоятельств дела № А40-12345/2026.",
        source: { kind: "draft", draftId: 42, draftRevision: 7, draftContentHash: contentHash },
      },
    ],
    scenes: scenesFor(durationSeconds),
  };
}

describe("legal video duration and structure", () => {
  it.each(LEGAL_VIDEO_DURATIONS)("builds an exact %i-second production timeline", (duration) => {
    const script = createLegalVideoScript(inputFor(duration));

    expect(script.scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0)).toBe(duration);
    expect(script.scenes.map((scene) => scene.order)).toEqual([1, 2, 3]);
    expect(script.scenes.map((scene) => scene.role)).toEqual(["hook", "body", "cta"]);
    expect(script.scenes[0].productionTiming).toEqual({ startSecond: 0, endSecond: durationsFor(duration)[0] });
    expect(script.scenes.at(-1)?.productionTiming.endSecond).toBe(duration);
    expect(script.scenes.every((scene) => scene.voiceOver && scene.onScreenText && scene.visualDirection)).toBe(true);
  });

  it("rejects a persisted snapshot whose explicit production timing was removed or changed", () => {
    const script = createLegalVideoScript(inputFor());
    const missing = structuredClone(script) as unknown as { scenes: Array<Record<string, unknown>> };
    delete missing.scenes[0].productionTiming;
    expect(() => validateLegalVideoScript(missing)).toThrow(LegalVideoValidationError);

    const changed = structuredClone(script);
    changed.scenes[1].productionTiming.startSecond = 6;
    expect(() => validateLegalVideoScript(changed)).toThrow(LegalVideoValidationError);
  });

  it("rejects gaps, duplicate positions and a duration mismatch instead of repairing order", () => {
    const bad = inputFor();
    bad.scenes = bad.scenes.map((scene, index) => index === 1
      ? { ...scene, order: 1, durationSeconds: 19 }
      : scene);

    expect(() => createLegalVideoScript(bad)).toThrow(LegalVideoValidationError);
    try {
      createLegalVideoScript(bad);
    } catch (error) {
      expect((error as LegalVideoValidationError).issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: "scenes.1.order", code: "invalid_value" }),
        expect.objectContaining({ path: "scenes", code: "invalid_value" }),
      ]));
    }
  });
});

describe("legal video source lineage", () => {
  it("preserves the exact draft revision and produces tamper-evident evidence", () => {
    const script = createLegalVideoScript(inputFor());
    const deadline = script.sourceEvidence.find((item) => item.id === "deadline");

    expect(script.sourceDraft).toEqual(inputFor().sourceDraft);
    expect(deadline?.source).toEqual({
      kind: "draft",
      draftId: 42,
      draftRevision: 7,
      draftContentHash: inputFor().sourceDraft.contentHash,
    });
    expect(deadline?.evidenceHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(validateLegalVideoScript(structuredClone(script))).toEqual(script);

    const changed = structuredClone(script);
    changed.sourceEvidence[0].claim = "Срок составляет 12 дней.";
    expect(() => validateLegalVideoScript(changed)).toThrow(LegalVideoValidationError);

    const wrongDraft = inputFor();
    wrongDraft.sourceDraft.contentHash = "a".repeat(64);
    expect(() => createLegalVideoScript(wrongDraft)).toThrow(LegalVideoValidationError);
  });

  it("rejects claim IDs that are not present in the immutable evidence snapshot", () => {
    const bad = inputFor();
    bad.scenes = bad.scenes.map((scene, index) => index === 1
      ? { ...scene, sourceClaimIds: [...scene.sourceClaimIds, "invented-claim"] }
      : scene);

    expect(() => createLegalVideoScript(bad)).toThrow(LegalVideoValidationError);
    try {
      createLegalVideoScript(bad);
    } catch (error) {
      expect((error as LegalVideoValidationError).issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "unknown_source_claim" }),
      ]));
    }
  });
});

describe("legal video factual marker guard", () => {
  it.each([
    "С 16 сентября 2026 года изменился срок ответа.",
    "Неустойка составляет 15 процентов.",
    "Неустойка составляет 200 000 рублей.",
    "Правило установлено ст. 446 АПК РФ.",
    "Вывод дан по делу № А41-12345/2026.",
    "Ответ нужно направить в течение 12 дней.",
    "Проверка занимает 10 лет.",
  ])("blocks an edited factual marker absent from cited source: %s", (voiceOver) => {
    const current = createLegalVideoScript(inputFor());
    const edited = current.scenes.map((scene, index) => ({
      id: scene.id,
      order: scene.order,
      role: scene.role,
      durationSeconds: scene.durationSeconds,
      voiceOver: index === 1 ? voiceOver : scene.voiceOver,
      onScreenText: scene.onScreenText,
      visualDirection: scene.visualDirection,
      sourceClaimIds: [...scene.sourceClaimIds],
    }));

    expect(() => reviseLegalVideoScript(current, { scenes: edited })).toThrow(LegalVideoValidationError);
    try {
      reviseLegalVideoScript(current, { scenes: edited });
    } catch (error) {
      expect((error as LegalVideoValidationError).issues.some((item) =>
        item.code === "unsupported_factual_marker"
      )).toBe(true);
    }
  });

  it("allows explicit production timing but treats a number inserted into narrative as a claim", () => {
    const script = createLegalVideoScript(inputFor());
    expect(script.scenes[0].productionTiming).toEqual({ startSecond: 0, endSecond: 5 });

    const bad = inputFor();
    bad.scenes = bad.scenes.map((scene, index) => index === 0
      ? { ...scene, visualDirection: "На 5 секунде показать документ." }
      : scene);
    expect(() => createLegalVideoScript(bad)).toThrow(LegalVideoValidationError);
  });
});

describe("legal video deterministic hand-off", () => {
  it("produces deterministic hashes, revisions and a source-complete production brief", () => {
    const first = createLegalVideoScript(inputFor(45));
    const second = createLegalVideoScript(structuredClone(inputFor(45)));
    expect(second).toEqual(first);
    expect(first.revisionHash).toMatch(/^[a-f0-9]{64}$/u);

    const revisedA = reviseLegalVideoScript(first, { title: "Проверка срока ответа" });
    const revisedB = reviseLegalVideoScript(first, { title: "Проверка срока ответа" });
    expect(revisedA.revision).toBe(2);
    expect(revisedB.revisionHash).toBe(revisedA.revisionHash);
    expect(revisedA.revisionHash).not.toBe(first.revisionHash);

    const brief = exportLegalVideoProductionBrief(revisedA);
    expect(brief).toContain("00:00–00:07 · ХУК");
    expect(brief).toContain("Озвучка:");
    expect(brief).toContain("Текст на экране:");
    expect(brief).toContain("Визуал / B-roll:");
    expect(brief).toContain("Исходный черновик: #42, ревизия 7");
    expect(brief).toContain(`[deadline] Дата и срок`);
    expect(brief).toContain("не является юридической консультацией");
    expect(exportLegalVideoProductionBrief(revisedB)).toBe(brief);
  });

  it("rejects hostile and unbounded text before it can reach an export", () => {
    const hostile = inputFor();
    hostile.title = "<script>Украсть данные</script>";
    expect(() => createLegalVideoScript(hostile)).toThrow(LegalVideoValidationError);

    const oversized = inputFor();
    oversized.scenes = oversized.scenes.map((scene, index) => index === 1
      ? { ...scene, onScreenText: "А".repeat(281) }
      : scene);
    expect(() => createLegalVideoScript(oversized)).toThrow(LegalVideoValidationError);
  });
});
