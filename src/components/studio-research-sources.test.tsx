// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import { StudioResearchProgress, StudioResearchSources } from "./studio-research-sources";
import { parseStudioResearchHeaders } from "@/lib/studio-research-view";

afterEach(cleanup);

function header(payload: unknown): string {
  return encodeURIComponent(JSON.stringify(payload));
}

it("скрывает блок источников, когда Аврора не выходила в интернет", () => {
  render(<StudioResearchSources research={null} />);
  const none = parseStudioResearchHeaders("none", null);
  expect(none).toBeNull();
  expect(screen.queryByText("Источники")).toBeNull();
  expect(screen.queryByRole("link")).toBeNull();
});

it("показывает источники ссылками с датой и уровнем доверия в новой вкладке", () => {
  const view = parseStudioResearchHeaders("ok", header({
    used: true,
    reason: "Событие во внешнем мире",
    queries: 3,
    pages: 5,
    findings: 4,
    sources: [
      { label: "OpenAI", url: "https://openai.com/index/new-model", date: "2026-09-30", tier: "Отраслевой источник" },
      { label: "Ведомости", url: "https://www.vedomosti.ru/tech/1", date: null, tier: null },
    ],
  }));
  render(<StudioResearchSources research={view} />);
  expect(screen.getByRole("heading", { name: /Источники/u })).toBeTruthy();
  const link = screen.getByRole("link", { name: "OpenAI" }) as HTMLAnchorElement;
  expect(link.href).toBe("https://openai.com/index/new-model");
  expect(link.target).toBe("_blank");
  expect(link.rel).toBe("noopener noreferrer");
  expect(screen.getByText("— 30.09.2026")).toBeTruthy();
  expect(screen.getByText("Отраслевой источник")).toBeTruthy();
  expect(screen.getByText("Запросов: 3 · Страниц: 5 · Подтверждённых фактов: 4")).toBeTruthy();
  expect(screen.queryByText(/не нашла подтверждаемых источников/u)).toBeNull();
});

it("честно говорит, что поиск был, но подтверждённых фактов нет", () => {
  const view = parseStudioResearchHeaders("empty", header({
    used: true,
    queries: 4,
    pages: 9,
    findings: 0,
    sources: [],
  }));
  render(<StudioResearchSources research={view} />);
  expect(screen.getByText(/не нашла подтверждаемых источников/u)).toBeTruthy();
  expect(screen.queryByRole("link")).toBeNull();
  expect(screen.getByText("Запросов: 4 · Страниц: 9 · Подтверждённых фактов: 0")).toBeTruthy();
});

it("показывает строку прогресса вместо текста", () => {
  render(<StudioResearchProgress label="Аврора смотрит в интернет…" />);
  expect(screen.getByRole("status").textContent).toContain("Аврора смотрит в интернет…");
});
