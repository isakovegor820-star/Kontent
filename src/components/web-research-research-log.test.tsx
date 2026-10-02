// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { WebResearchResearchLog } from "./web-research-research-log";

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/lib/use-project-transport", () => ({ useProjectFetch: () => mocks.fetch }));

const run = {
  id: 41,
  triggerKind: "manual",
  topic: "юридическая практика договоры",
  categories: ["law"],
  language: "RU",
  status: "completed",
  planFingerprint: "wrp-1-2",
  queries: [
    { id: "q1", text: "site:pravo.gov.ru законопроект изменения", category: "law", siteScoped: true },
    { id: "q2", text: "законопроект изменения 2026", category: "law", siteScoped: false },
  ],
  log: [
    { step: "gate", message: "Отклонено на habr.com: Число из утверждения не найдено в источнике", detail: { url: "https://habr.com/ru/news/1", code: "number_not_in_source" }, at: "2026-10-02T09:00:10.000Z" },
  ],
  stats: { queries: 6, pages: 12, candidates: 41, spentMs: 42_000 },
  findingsCount: 1,
  rejectionsCount: 1,
  startedAt: "2026-10-02T09:00:00.000Z",
  finishedAt: "2026-10-02T09:00:42.000Z",
  error: null,
};

const finding = {
  fingerprint: "wf-abc-12",
  kind: "law",
  claim: "Законопроект внесён в Государственную Думу",
  quote: "Законопроект внесён в Государственную Думу и направлен в профильный комитет",
  title: "Карточка законопроекта",
  legalStatus: "bill_submitted",
  legalStatusLabel: "Законопроект внесён в Госдуму",
  publishedAt: "2026-09-28T10:00:00.000Z",
  ageDays: 4,
  corroborationCount: 0,
  trusted: true,
  status: "new",
  source: {
    url: "https://sozd.duma.gov.ru/bill/123456-8",
    domain: "sozd.duma.gov.ru",
    label: "СОЗД Государственной Думы — законопроекты",
    tier: "official",
    tierLabel: "Официальный источник",
    trust: 95,
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetch.mockResolvedValue(Response.json({ run: null, findings: [] }));
});
afterEach(cleanup);

it("explains an empty log in Russian and offers the single research action", async () => {
  render(<WebResearchResearchLog channelId={11} />);
  expect(await screen.findByText("Аврора ещё не выходила в интернет по этому каналу")).toBeTruthy();
  expect(screen.getByRole("button", { name: /Исследовать интернет/u })).toBeTruthy();
  expect(screen.queryByText("Полный лог исследования · отклонено 1")).toBeNull();
});

it("runs the research through the scoped endpoint and reports the plan size", async () => {
  const onFinished = vi.fn();
  mocks.fetch.mockResolvedValueOnce(Response.json({ run: null, findings: [] }));
  mocks.fetch.mockResolvedValueOnce(Response.json({ ok: true, runId: 42, plan: { queries: [{}, {}, {}] } }, { status: 202 }));
  mocks.fetch.mockResolvedValue(Response.json({ run: null, findings: [] }));
  render(<WebResearchResearchLog channelId={11} onFinished={onFinished} />);
  await screen.findByText("Аврора ещё не выходила в интернет по этому каналу");

  fireEvent.click(screen.getByRole("button", { name: /Исследовать интернет/u }));
  await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1));

  expect(onFinished.mock.calls[0][0]).toContain("Аврора вышла в интернет: 3 запроса");
  const [url, request] = mocks.fetch.mock.calls[1];
  expect(url).toBe("/api/web-research?channel=11");
  expect(request.method).toBe("POST");
  expect(JSON.parse(request.body)).toEqual({ action: "run", language: "RU" });
  expect(await screen.findByRole("status")).toBeTruthy();
});

it("never reports success when the research queue is unavailable", async () => {
  const onFinished = vi.fn();
  mocks.fetch.mockResolvedValueOnce(Response.json({ run: null, findings: [] }));
  mocks.fetch.mockResolvedValueOnce(Response.json({
    error: "research_queue_unavailable",
    message: "Воркер исследования недоступен, поэтому Аврора не вышла в интернет. Запуск отменён — повторите попытку позже.",
  }, { status: 503 }));
  render(<WebResearchResearchLog channelId={11} onFinished={onFinished} />);
  await screen.findByText("Аврора ещё не выходила в интернет по этому каналу");

  fireEvent.click(screen.getByRole("button", { name: /Исследовать интернет/u }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.getByText(/Воркер исследования недоступен/u)).toBeTruthy();
  expect(onFinished).not.toHaveBeenCalled();
  expect(screen.queryByText(/Аврора вышла в интернет/u)).toBeNull();
});

it("shows the run summary, the rejection log and accepted findings with citations", async () => {
  mocks.fetch.mockResolvedValue(Response.json({ run, findings: [finding] }));
  render(<WebResearchResearchLog channelId={11} />);

  const summary = await screen.findByText(/Аврора выполнила 6 запросов, прочитала 12 страниц/u);
  expect(summary.textContent).toContain("отклонила 1 факт");

  expect(screen.getByText("Полный лог исследования · отклонено 1")).toBeTruthy();
  expect(screen.getByText("Число из утверждения не найдено в источнике")).toBeTruthy();
  expect(screen.getByText(/https:\/\/habr\.com\/ru\/news\/1/u)).toBeTruthy();

  expect(screen.getByText("Факты, прошедшие проверку")).toBeTruthy();
  expect(screen.getByText("Законопроект внесён в Государственную Думу")).toBeTruthy();
  expect(screen.getByText("«Законопроект внесён в Государственную Думу и направлен в профильный комитет»")).toBeTruthy();
  expect(screen.getByText("Официальный источник")).toBeTruthy();
  expect(screen.getByText("Законопроект внесён в Госдуму")).toBeTruthy();
  const link = screen.getByRole("link", { name: "СОЗД Государственной Думы — законопроекты" }) as HTMLAnchorElement;
  expect(link.getAttribute("href")).toBe("https://sozd.duma.gov.ru/bill/123456-8");
  expect(link.getAttribute("rel")).toBe("noopener noreferrer");

  expect(screen.getByText("Запросы исследования · 2")).toBeTruthy();
  expect(screen.getByText("site:pravo.gov.ru законопроект изменения")).toBeTruthy();
  expect(screen.getByText("Первоисточники")).toBeTruthy();
});

it("removes a dismissed finding through the endpoint and keeps the rest", async () => {
  mocks.fetch.mockResolvedValue(Response.json({ run, findings: [finding] }));
  render(<WebResearchResearchLog channelId={11} />);
  await screen.findByText("Законопроект внесён в Государственную Думу");

  mocks.fetch.mockResolvedValueOnce(Response.json({ ok: true, updated: 1 }));
  fireEvent.click(screen.getByRole("button", { name: /Не использовать/u }));
  await waitFor(() => expect(screen.queryByText("Законопроект внесён в Государственную Думу")).toBeNull());

  const [url, request] = mocks.fetch.mock.calls[1];
  expect(url).toBe("/api/web-research?channel=11");
  expect(JSON.parse(request.body)).toEqual({ action: "dismiss", fingerprints: ["wf-abc-12"] });
  expect(screen.getByText("Факт убран из подборки.")).toBeTruthy();
});

it("asks for a channel instead of silently doing nothing without one", async () => {
  render(<WebResearchResearchLog channelId={null} />);
  expect(await screen.findByText(/Исследование интернета работает для выбранного канала/u)).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Исследовать интернет/u })).toBeNull();
  expect(mocks.fetch).not.toHaveBeenCalled();
});
