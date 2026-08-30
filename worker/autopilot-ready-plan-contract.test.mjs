import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const source = await readFile(new URL("../worker.mjs", import.meta.url), "utf8");

describe("Autopilot ready-plan generation contract", () => {
  it("accepts a usable length-limited post only on paths guarded by the quality gate", () => {
    expect(source).not.toContain('acceptLengthLimitedOutput: surface === "autopilot-plan"');
    expect(source).toContain("acceptLengthLimitedOutput: options?.acceptLengthLimitedOutput === true");
    expect(source.match(/acceptLengthLimitedOutput: true/g)?.length).toBe(3);
    expect(source).toContain("prepareAutopilotDraftForm(");
    expect(source).toContain("assessAutopilotDraft(");
  });

  // Confirm-план принимает безопасные тексты на согласовании, но не получает право публикации.
  it("delivers reader-ready and human-review posts without enabling blind publication", () => {
    expect(source).not.toContain("AUTOPILOT_QUALITY_REWRITE_ATTEMPTS");
    expect(source).toContain("boundedAutopilotRewriteAttempts(itemQuality.retryLimit)");
    expect(source).toContain("boundedAutopilotRewriteAttempts(quality.retryLimit) - Number(item._rewriteAttempts || 0)");
    expect(source.match(/autopilotDraftsDeliverable\(publicationTargetCount, topics, items\)/g)?.length).toBe(1);
    expect(source).toContain("status = 'partial'");
    expect(source).toContain("isAutopilotHumanReviewItem,");
    expect(source.match(/isAutopilotHumanReviewItem\(item\)/g)?.length).toBeGreaterThanOrEqual(2);
    expect(source).toMatch(
      /const variedPairs = items[\s\S]*?isAutopilotReaderReadyItem\(item\) \|\| isAutopilotHumanReviewItem\(item\)/,
    );
    expect(source).not.toContain("full\n    ? autopilotBuildComplete(N, topics, items)");
    expect(source).not.toMatch(/full\s*\n?\s*\?\s*autopilotBuildComplete\(N, topics, items\)/);
    expect(source).toContain("const full = false;");
    expect(source).toContain("const fullAtCommit = false;");
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
    expect(source).toContain('item.reviewReason = "rewrite"');
    expect(source).toContain('code: "duplicate"');
    expect(source).toContain("delete item.autoApprove;");
  });

  it("runs manual builds on a dedicated resumable queue", () => {
    expect(source).toContain('const AUTOPILOT_QUEUE = "autopilot-plans";');
    expect(source).toContain("new Worker(AUTOPILOT_QUEUE, processAutopilotPlanJob, { connection, concurrency: 2 })");
    expect(source).toContain("autopilotCheckpointItem(item)");
    expect(source).toContain("await autopilotWorker?.close()");
  });

  it("preserves ready checkpoints and moves provider failure into durable queue recovery", () => {
    expect(source).toContain("attemptTimeoutMs: AUTOPILOT_AI_ATTEMPT_TIMEOUT_MS");
    expect(source).toContain("overallTimeoutMs: AUTOPILOT_AI_OVERALL_TIMEOUT_MS");
    expect(source).toContain("fallbackEngines: autopilotFallbackEngines(selectedEngine)");
    expect(source).toContain("maxAttempts: 4");
    expect(source).toContain("circuitFailureThreshold: Math.max(2, configuredAiConcurrency(selectedEngine))");
    expect(source).toContain("autopilotProviderWaitingItem({");
    expect(source.match(/autopilotProviderWaitingItem\(\{/g)?.length).toBeGreaterThanOrEqual(2);
    expect(source).toContain('buildState === "waiting_provider"');
    expect(source).toContain('recoveryState: "waiting_provider"');
    expect(source).toContain("isRetryableAiCompletionError(error)");
    expect(source).toContain("{ throwOnUnavailable: true, acceptLengthLimitedOutput: true }");
    expect(source).toContain("coalesce(build_report, '{}'::jsonb) || $4::jsonb");
    expect(source).toContain("process.env.AUTOPILOT_SEMANTIC_ENGINE || DEFAULT_AUTOPILOT_ENGINE");
    expect(source).toContain('generationEngine === "navy-minimax-m3" ? 2 : 3');
  });

  it("keeps the settings mutex while requiring a separate human approval", () => {
    expect(source).toMatch(/select enabled, mode, approvals_streak[\s\S]*?for update/);
    expect(source).toContain("Publication itself always waits for");
    expect(source).not.toMatch(/fullAtCommit\s*=\s*true/u);
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
    expect(source.match(/prepareAutopilotDraftForm\(/g)?.length).toBe(6);
  });

  it("держит hard-block внутри сборки, но считает human-review доставляемым", () => {
    expect(source).toContain('qualityResult.publicationDisposition === "blocked"');
    expect(source).toContain("reviewRequired: needsHumanReview || needsHumanEdit");
    expect(source).toMatch(/needsHumanEdit\s*\?\s*"quality_review"/);
    expect(source).toContain("const deliverablePairs = items");
    expect(source).toContain("isAutopilotReaderReadyItem(item) || isAutopilotHumanReviewItem(item)");
  });

  it("не показывает человеку внутренний числовой порог как результат плана", () => {
    expect(source).not.toContain(
      "Каждый текст проходит редакционный порог ${quality.qualityThreshold}/100",
    );
    expect(source).toContain("По одному посту в день:");
    expect(source).not.toContain("Каждый текст проходит автоматическую редактуру");
    expect(source).not.toContain("модель — ${engineLabel}");
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

  it("repairs only claimed failed indexes and never regenerates ready checkpoints", () => {
    expect(source).toContain("const targetedRepairIndexes = Array.isArray(repairIndexes)");
    expect(source).toContain("targetedRepairIndexes && !targetedRepairIndexes.has(i)");
    expect(source).toContain("const reusedCheckpointIndexes = new Set()");
    expect(source).toContain("if (reusedCheckpointIndexes.has(index))");
    expect(source).toContain('? "autopilot-repair"');
    expect(source).toContain('? "autopilot-continue"');
    expect(source).toContain("ai_call_count = $5");
    expect(source).toContain("clearWorkerAiCallCount(usage.reservationId)");
    expect(source).toContain("const checkpointDraft = targetedRepairIndexes?.has(i)");
    expect(source).toContain("let candidateRaw = checkpointDraft || await askAI(");
  });

  it("finalizes five publications from six ready candidates and keeps the reserve internal", () => {
    expect(source).toContain("const candidateSelection = selectAutopilotCandidates(");
    expect(source).toContain("if (!candidateSelection.complete)");
    expect(source).toContain("status = 'partial'");
    expect(source).toContain("candidate_items = $4::jsonb");
    expect(source).toContain("items = selectedPairs.map(({ item }) => item)");
    expect(source).toContain("candidate_count, candidate_items");
    expect(source).toContain("readyCount: variedPairs.length");
    expect(source).toContain("failedCount: N - variedPairs.length");
    expect(source).toContain("targetCount: publicationTargetCount");
  });

  it("treats the news quota as a reported goal instead of a partial-plan gate", () => {
    expect(source).toMatch(
      /const selectionDeficit = Math\.max\(\s*0,\s*publicationTargetCount - selectedPairs\.length,?\s*\)/,
    );
    expect(source).toContain("newsQuotaShortfall: Math.max(0, selectionNewsQuota - selectedNewsCount)");
  });

  it("rebuilds the final publication schedule after selecting winners from the reserve", () => {
    expect(source).toContain("const publicationSlots = periodSlots(publicationTargetCount, planWeeks, bestHour)");
    expect(source).toContain("pair.item.scheduledAt = publicationSlots[index]");
    expect(source.indexOf("const candidateSelection = selectAutopilotCandidates(")).toBeLessThan(
      source.indexOf("const publicationSlots = periodSlots(publicationTargetCount, planWeeks, bestHour)"),
    );
  });

  it("turns an unfinished quality pass into a durable automatic continuation", () => {
    expect(source).toContain("autopilotAutoRecoveryReport(report");
    expect(source).toContain("dispatchAutopilotContinuation({");
    expect(source).toContain("claimAutopilotContinuationJob(job)");
    expect(source).toContain("status = 'partial'");
    expect(source).toContain("last_repair_job_id = $9::uuid");
  });

  it("records repair completion in the same transaction as plan completion", () => {
    expect(source).toContain("set status = 'completed', ai_call_count = $5, terminal_outcome = 'complete'");
    expect(source).toContain("diagnostic = jsonb_build_object('resultPlanId'");
    expect(source).toContain("monthly_campaign_plan_id");
  });

  it("transfers Growth lineage from the building placeholder to the final plan", () => {
    expect(source).toContain("const linkedGrowthMoveIds = expectedPlanId == null");
    expect(source).toContain("artifact_autopilot_plan_id = $3");
    expect(source).toContain("set artifact_autopilot_plan_id = $4, updated_at = now()");
    expect(source).toContain("growth move plan lineage changed during generation");
  });
});
