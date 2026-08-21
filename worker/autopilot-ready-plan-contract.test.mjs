import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const source = await readFile(new URL("../worker.mjs", import.meta.url), "utf8");

describe("Autopilot ready-plan generation contract", () => {
  it("never accepts a provider response stopped at the token limit", () => {
    expect(source).not.toContain('acceptLengthLimitedOutput: surface === "autopilot-plan"');
  });

  // План доходит до человека в обоих режимах, но только после reader-ready фильтра.
  // Право на выпуск считается отдельно для каждого оставшегося сильного поста.
  it("delivers only reader-ready posts and gates publication per post", () => {
    expect(source).toContain("const AUTOPILOT_QUALITY_REWRITE_ATTEMPTS = 2;");
    expect(source.match(/autopilotDraftsDeliverable\(items\.length, topics, items\)/g)?.length).toBe(2);
    expect(source.match(/isAutopilotReaderReadyItem\(item\)/g)?.length).toBeGreaterThanOrEqual(2);
    expect(source).not.toContain("full\n    ? autopilotBuildComplete(N, topics, items)");
    expect(source).not.toMatch(/full\s*\n?\s*\?\s*autopilotBuildComplete\(N, topics, items\)/);
    expect(source).toContain("fullAtCommit && item.autoApprove && evaluation.eligible");
  });

  // Повтор дешевле предотвратить правилом, чем поймать проверкой и выбросить всю сборку.
  it("tells the model what must not be repeated before it writes", () => {
    expect(source).toContain("function varietyRulesW(variety)");
    expect(source).toContain("ОСТАЛЬНЫЕ ПОСТЫ ЭТОЙ СБОРКИ");
    expect(source).toContain("УЖЕ ВЫХОДИЛО В КАНАЛЕ");
    expect(source).toMatch(/otherTopics: topics\.filter/);
    expect(source).toContain("recentOpenings,");
    // Правило уходит в промпт генерации, а не только в переписывание после провала.
    expect(source.indexOf("const varietyRules = varietyRulesW(variety)")).toBeGreaterThan(0);
  });

  it("маркирует один повторяющийся пост вместо отмены всей сборки", () => {
    expect(source).not.toContain('return { error: "content_variety_insufficient" }');
    expect(source).toContain('item.reviewReason = "content_variety"');
    expect(source).toContain("delete item.autoApprove;");
  });

  it("runs manual builds on a dedicated resumable queue", () => {
    expect(source).toContain('const AUTOPILOT_QUEUE = "autopilot-plans";');
    expect(source).toContain("new Worker(AUTOPILOT_QUEUE, processAutopilotPlanJob, { connection, concurrency: 2 })");
    expect(source).toContain("autopilotCheckpointItem(item)");
    expect(source).toContain("await autopilotWorker?.close()");
  });

  it("keeps provider failure inside a short attempt budget with a fast cloud fallback", () => {
    expect(source).toContain("attemptTimeoutMs: AUTOPILOT_AI_ATTEMPT_TIMEOUT_MS");
    expect(source).toContain("overallTimeoutMs: AUTOPILOT_AI_OVERALL_TIMEOUT_MS");
    expect(source).toContain("fallbackEngines: autopilotFallbackEngines(selectedEngine)");
    expect(source).toContain("maxAttempts: 4");
    expect(source).toContain("circuitFailureThreshold: 1");
    expect(source).toContain("process.env.AUTOPILOT_SEMANTIC_ENGINE || DEFAULT_AUTOPILOT_ENGINE");
    expect(source).toContain('generationEngine === "navy-minimax-m3" ? 2 : 3');
  });

  it("rechecks full-auto eligibility while locking settings before publication", () => {
    expect(source).toMatch(/select enabled, mode, approvals_streak[\s\S]*?for update/);
    expect(source).toContain("fullAtCommit && item.autoApprove");
    expect(source).not.toContain("if (item.autoApprove && evaluation.eligible");
  });

  // Строгий профиль использует и базу знаний, и найденные новости. Только отсутствие обоих
  // типов источников должно остановить сборку до первого запроса к модели.
  it("refuses a source-required build only when both knowledge and news are empty", () => {
    const discovery = source.indexOf("await discoverAutopilotNews(");
    const preflight = source.indexOf('return { error: "no_sources_found" }');
    expect(discovery).toBeGreaterThan(0);
    expect(preflight).toBeGreaterThan(0);
    expect(source).toMatch(/quality\.factsPolicy === "source_required" && facts === 0 && newsCandidates\.length === 0/);
    expect(discovery).toBeLessThan(preflight);
    expect(preflight).toBeLessThan(source.indexOf("await planTopics("));
    expect(source).toContain('"no_sources_found",\n  "no_brief"');
  });

  // Второе расхождение промпта и проверки: без источников модель не получала запрета на
  // цифры и даты, писала их, и findInvented заворачивал весь план.
  it("warns the model that specifics are forbidden when no support was found", () => {
    expect(source).toContain("ИСТОЧНИКОВ НЕТ.");
    expect(source).toMatch(/Запрещено называть любые цифры, даты, годы, суммы/);
  });

  // Форма поста — работа кода. Пока её приводила только модель, план заворачивался за
  // лишний эмодзи и служебную метку, а человеку предлагали «выбрать другую модель».
  it("приводит форму к профилю канала на каждом пути черновика", () => {
    expect(source).not.toContain("fitAutopilotDraftLength(");
    expect(source.match(/prepareAutopilotDraftForm\(/g)?.length).toBe(4);
  });

  it("держит непрошедший пост внутри сборки и фильтрует его перед показом", () => {
    expect(source).toContain("const needsHumanEdit = Boolean(aiDraft && !qualityResult.passed)");
    expect(source).toContain("reviewRequired: needsHumanReview || needsHumanEdit");
    expect(source).toMatch(/needsHumanEdit\s*\?\s*"quality_review"/);
    expect(source).toContain("const readerReadyPairs = items");
    expect(source).toContain("isAutopilotReaderReadyItem(item)");
  });

  it("не показывает человеку внутренний числовой порог как результат плана", () => {
    expect(source).not.toContain(
      "Каждый текст проходит редакционный порог ${quality.qualityThreshold}/100",
    );
    expect(source).toContain("Каждый текст проходит автоматическую редактуру");
  });

  it("logs which gate rejected the plan instead of a bare counter", () => {
    expect(source).toContain("autopilotQualityFailureReport(items, N)");
    expect(source).toMatch(/cause\.code\}×\$\{cause\.count\}/);
  });

  it("keeps a durable build heartbeat through long generation phases", () => {
    expect(source).toContain("const stopBuildHeartbeat = startAutopilotBuildHeartbeat");
    expect(source).toContain("set build_activity_at = now()");
    expect(source).toContain("await stopBuildHeartbeat()");
  });
});
