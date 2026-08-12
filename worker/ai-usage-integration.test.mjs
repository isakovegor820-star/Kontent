import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { WORKER_AI_SURFACES } from "./ai-call-policy.mjs";

const source = await readFile(new URL("../worker.mjs", import.meta.url), "utf8");

describe("worker AI usage integration contract", () => {
  it("binds autopilot jobs to planId and commits inside the plan transaction", () => {
    expect(source).toContain(
      'key: workerAiUsageCompositeKey("autopilot-plan", [projectId, planId])',
    );
    expect(source).toMatch(
      /buildAutopilotPlan\(\s*projectId,\s*userId,\s*channelId,\s*planId,\s*usage\.reservationId/u,
    );
    expect(source).toContain("commitWorkerAiUsage(tx, userId, usageReservationId)");
    expect(source).toContain("releaseWorkerAiUsage(pool, userId, usage.reservationId)");
    expect(source).toContain("set status = 'error', rules = 'ai_usage_limit'");
  });

  it("binds bot callbacks to Telegram update_id and persists the result before commit", () => {
    expect(source).toContain("botIdea(userId, Number(action), u.update_id)");
    expect(source).toContain('key: workerAiUsageKey("bot-idea", callbackUpdateId)');
    expect(source.indexOf("insert into drafts")).toBeLessThan(
      source.indexOf("commitWorkerAiUsage(tx, userId, usage.reservationId)"),
    );
    expect(source).toContain("if (outcome?.retry)");
    expect(source).toContain("Дневной лимит ИИ исчерпан");
  });

  it("classifies every chat-provider call and requires reservation context for user output", () => {
    const calls = [...source.matchAll(/askAI\(\s*"([^"]+)"\s*,\s*([^,\n]+)/gu)]
      .map((match) => ({ surface: match[1], reservation: match[2].trim() }));
    expect(calls).toHaveLength((source.match(/\baskAI\(/gu) ?? []).length - 1);
    expect(new Set(calls.map((call) => call.surface))).toEqual(new Set([
      "autopilot-plan",
      "bot-idea",
      "competitor-idea",
      "competitor-niche-classifier",
      "competitor-reader-classifier",
      "profile-refresh",
      "rss-summary",
    ]));
    for (const call of calls) {
      expect(WORKER_AI_SURFACES[call.surface]).toBeDefined();
      expect(call.reservation === "null").toBe(WORKER_AI_SURFACES[call.surface].billing === "system");
    }
  });

  it("meters background visible artifacts with deterministic keys and durable outcomes", () => {
    expect(source).toContain('key: workerAiUsageKey("competitor-idea", contentIdeaId)');
    expect(source).toContain(
      'key: workerAiUsageCompositeKey("autopilot-weekly", [projectId, channelId, mskPlanningWeek()])',
    );
    expect(source).toMatch(
      /from autopilot_settings s[\s\S]*member\.project_id = s\.project_id[\s\S]*member\.role in \('owner','author','approver'\)/u,
    );
    expect(source).toContain('key: workerAiUsageCompositeKey("rss-summary", [feed.id, guidHash])');
    expect(source).toContain("commitWorkerAiUsage(tx, comp.user_id, usage.reservationId)");
    expect(source).toMatch(
      /buildAutopilotPlan\(\s*projectId,\s*userId,\s*channelId,\s*null,\s*usage\.reservationId/u,
    );
    expect(source).toContain(
      'key: workerAiUsageCompositeKey("monthly-campaign-regeneration", [projectId, operationId])',
    );
    expect(source).toContain("commitUsage: async (tx)");
    expect(source).toContain("aiUsageCommitted = await commitWorkerAiUsage(tx, userId, rssAiUsageReservationId)");
  });
});
