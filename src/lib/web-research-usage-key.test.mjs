import { describe, expect, it } from "vitest";

import { workerAiUsageCompositeKey, workerAiUsageKey } from "../../worker/ai-usage-reservation.mjs";
import { WEB_RESEARCH_USAGE_SCOPE, webResearchUsageKeyParts } from "./web-research-usage-key.mjs";

const URL = "https://publication.pravo.gov.ru/document/0001202412260005";

describe("ключ резервации квоты для исследования", () => {
  it("принимается контрактом резервации", () => {
    const key = workerAiUsageCompositeKey(WEB_RESEARCH_USAGE_SCOPE, webResearchUsageKeyParts(3, URL));
    expect(key).toBeTypeOf("string");
    expect(key.startsWith("worker:web-research-extract:3:")).toBe(true);
    // Длина ограничена контрактом: key =~ /^[a-z0-9][a-z0-9:_-]{7,127}$/
    expect(key.length).toBeLessThanOrEqual(128);
    expect(key).toMatch(/^[a-z0-9][a-z0-9:_-]{7,127}$/u);
  });

  it("показывает, почему сырой URL в ключ не годится", () => {
    // Ровно это сломало первый боевой прогон: оба конструктора отвергают адрес,
    // поэтому извлечение падало ещё до обращения к модели.
    expect(() => workerAiUsageKey(WEB_RESEARCH_USAGE_SCOPE, `3:${URL}`)).toThrow(TypeError);
    expect(() => workerAiUsageCompositeKey(WEB_RESEARCH_USAGE_SCOPE, [URL])).toThrow(TypeError);
  });

  it("устойчив к повторам и различает страницы", () => {
    const first = webResearchUsageKeyParts(7, URL);
    const again = webResearchUsageKeyParts(7, URL);
    const other = webResearchUsageKeyParts(7, "https://consultant.ru/law/hotdocs/87706.html");
    const otherRun = webResearchUsageKeyParts(8, URL);
    expect(first).toEqual(again);
    expect(first).not.toEqual(other);
    expect(first).not.toEqual(otherRun);
    expect(otherRun[0]).toBe("8");
  });

  it("каждая часть укладывается в ограничение контракта", () => {
    for (const part of webResearchUsageKeyParts(12_345, URL)) {
      expect(part).toMatch(/^[a-z0-9][a-z0-9_-]{0,47}$/u);
    }
  });

  it("отвергает некорректный номер запуска", () => {
    expect(() => webResearchUsageKeyParts(0, URL)).toThrow(TypeError);
    expect(() => webResearchUsageKeyParts(-1, URL)).toThrow(TypeError);
    expect(() => webResearchUsageKeyParts("не число", URL)).toThrow(TypeError);
    expect(() => webResearchUsageKeyParts(null, URL)).toThrow(TypeError);
  });

  it("переживает пустой адрес", () => {
    expect(() => webResearchUsageKeyParts(1, "")).not.toThrow();
    expect(webResearchUsageKeyParts(1, "")[1]).toHaveLength(32);
  });
});
