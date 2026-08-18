import { describe, expect, it } from "vitest";

import { buildTrendReferenceDraft } from "./trend-reference";

describe("buildTrendReferenceDraft", () => {
  it("stores an original trend as reference context for one destination", () => {
    expect(buildTrendReferenceDraft({
      trendId: 41,
      channelId: 7,
      clientKey: "draft_trend_reference_41",
      sourceLabel: "Legal Academy",
      scope: "global",
      text: "Исходный тренд",
    })).toMatchObject({
      text: "Исходный тренд",
      origin: "trend",
      sourceRef: {
        kind: "trend",
        id: "41",
        label: "Legal Academy",
        provenance: { kind: "trend", id: "41", label: "Legal Academy" },
      },
      channelIds: [7],
      clientKey: "draft_trend_reference_41",
    });
  });

  it("uses the worker idea only when the source post has no text", () => {
    expect(buildTrendReferenceDraft({
      trendId: 42,
      channelId: 7,
      clientKey: "draft_trend_reference_42",
      sourceLabel: "Источник",
      idea: { topic: "Тема идеи", hook: "Хук", structure: "Структура" },
    }).text).toBe("Хук\n\nСтруктура");
  });

  it("marks a verified internet result with its own server-checked provenance", () => {
    expect(buildTrendReferenceDraft({
      trendId: 91,
      channelId: 7,
      clientKey: "draft_radar_reference_91",
      sourceLabel: "Публичный источник",
      scope: "internet",
      text: "Проверенный текст из Telegram",
    }).sourceRef?.provenance).toEqual({
      kind: "radar_result",
      id: "91",
      label: "Публичный источник",
    });
  });

  it("preserves a PostgreSQL bigint id without a lossy Number conversion", () => {
    expect(buildTrendReferenceDraft({
      trendId: "9007199254740993",
      channelId: 7,
      clientKey: "draft_trend_reference_bigint",
      sourceLabel: "Источник",
      text: "Юридическая тема",
    }).sourceRef?.id).toBe("9007199254740993");
  });

  it("rejects an empty reference before any server write", () => {
    expect(() => buildTrendReferenceDraft({
      trendId: 43,
      channelId: 7,
      clientKey: "draft_trend_reference_43",
      sourceLabel: "Источник",
      text: "  ",
    })).toThrow("trend reference text is required");
  });

  it("rejects ambiguous source prose when no structured topic exists", () => {
    expect(() => buildTrendReferenceDraft({
      trendId: 44,
      channelId: 7,
      clientKey: "draft_trend_reference_44",
      sourceLabel: "Источник",
      text: "Вы это знали? Затем текст перескакивает на банкротство. А потом на конференцию.",
    })).toThrow("trend reference topic is required");
  });
});
