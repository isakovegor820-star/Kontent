// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import TrendsPage from "./page";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), push: vi.fn(), toast: vi.fn() }));
vi.mock("@/lib/store", () => ({ useStore: () => ({ toast: mocks.toast, realChannels: [
  { id: 11, network: "tg", is_active: true, title: "Канал А" },
  { id: 12, network: "tg", is_active: true, title: "Канал Б" },
] }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("@/components/app/shell", () => ({ AppShell: ({ children }: { children: React.ReactNode }) => <main>{children}</main> }));

function reply(body: object, status = 200) { return { ok: status < 400, status, json: async () => body }; }
function pending() {
  let resolve!: (value: ReturnType<typeof reply>) => void;
  const promise = new Promise<ReturnType<typeof reply>>(done => { resolve = done; });
  return { promise, resolve };
}
function dataset(url: string) {
  const params = new URL(url, "http://localhost").searchParams;
  const run = Number(params.get("run"));
  return {
    topic: params.get("topic"), sourceLabel: "Поиск по теме", periodLabel: params.get("period"),
    summary: { posts: 0, sources: 0, views: null, avgViews: null, postsWithViews: 0, postsWithReactions: 0 },
    coverage: {}, status: { competitors: 1, pending: 0, error: 0 }, items: [], topItems: [], series: [],
    search: run ? { id: run, status: "ready", stage: "ready", progress: 100 } : null,
  };
}
async function submit(query: string) {
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: query } });
  fireEvent.submit(screen.getByRole("searchbox").closest("form")!);
  await act(async () => {});
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("React", React);
  vi.stubGlobal("fetch", mocks.fetch);
  window.history.replaceState(null, "", "/app/trends?scope=internet&channel=11&period=week");
  mocks.fetch.mockImplementation(async (url: string) => reply(dataset(url)));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("keeps the newer query when a previous search acknowledges late, even if transport ignores abort", async () => {
  const old = pending();
  mocks.fetch.mockImplementation((url: string, init?: RequestInit) => init?.method === "POST"
    ? JSON.parse(String(init.body)).q === "ремонт" ? old.promise : Promise.resolve(reply({ run: { id: 102 } }, 202))
    : Promise.resolve(reply(dataset(url))));
  render(<TrendsPage />);
  await screen.findByText("Начни с темы");
  await submit("ремонт");
  await submit("рыбалка");
  await screen.findByRole("heading", { name: "Тема: рыбалка" });
  await act(async () => old.resolve(reply({ run: { id: 101 } }, 202)));
  expect(window.location.search).toContain("run=102");
  expect(screen.queryByRole("heading", { name: "Тема: ремонт" })).toBeNull();
  expect(mocks.fetch.mock.calls.filter(([url]) => String(url).includes("run=101"))).toHaveLength(0);
});

it("reuses the key after an uncertain response and uses a new key after an acknowledged refresh", async () => {
  let posts = 0;
  mocks.fetch.mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method !== "POST") return Promise.resolve(reply(dataset(url)));
    posts += 1;
    return posts === 1 ? Promise.reject(new TypeError("network")) : Promise.resolve(reply({ run: { id: 100 + posts } }, 202));
  });
  render(<TrendsPage />);
  await screen.findByText("Начни с темы");
  await submit("ремонт");
  await screen.findByText("Поиск не запустился");
  await submit("ремонт");
  await screen.findByRole("button", { name: "Обновить" });
  await submit("ремонт");
  await waitFor(() => expect(window.location.search).toContain("run=103"));
  const requests = mocks.fetch.mock.calls.filter(([, init]) => init?.method === "POST").map(([, init]) => init);
  expect(requests[0].headers["idempotency-key"]).toBe(requests[1].headers["idempotency-key"]);
  expect(requests[2].headers["idempotency-key"]).not.toBe(requests[1].headers["idempotency-key"]);
  expect(JSON.parse(requests[2].body)).toMatchObject({ scope: "telegram", period: "week", force: true });
});

it("discards a pending search after switching channels", async () => {
  const old = pending();
  mocks.fetch.mockImplementation((url: string, init?: RequestInit) => init?.method === "POST" ? old.promise : Promise.resolve(reply(dataset(url))));
  render(<TrendsPage />);
  await screen.findByText("Начни с темы");
  await submit("ремонт");
  fireEvent.click(screen.getByRole("button", { name: "Канал Б" }));
  await screen.findByText("Начни с темы");
  await act(async () => old.resolve(reply({ run: { id: 101 } }, 202)));
  expect(window.location.search).toContain("channel=12");
  expect(window.location.search).not.toContain("run=");
  expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("");
});

it("can retry a confirmed failed run immediately with a fresh request key", async () => {
  let posts = 0;
  mocks.fetch.mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method !== "POST") {
      const data = dataset(url);
      if (data.search?.id === 101) data.search.status = "failed";
      return Promise.resolve(reply(data));
    }
    posts += 1;
    return Promise.resolve(posts === 1
      ? reply({ run: { id: 101, status: "failed" }, error: "queue_unavailable" }, 503)
      : reply({ run: { id: 102, status: "queued" } }, 202));
  });
  render(<TrendsPage />);
  await screen.findByText("Начни с темы");
  await submit("ремонт");
  await screen.findByText(/Не удалось завершить поиск/);
  await submit("ремонт");
  await waitFor(() => expect(window.location.search).toContain("run=102"));
  const requests = mocks.fetch.mock.calls.filter(([, init]) => init?.method === "POST").map(([, init]) => init);
  expect(requests[1].headers["idempotency-key"]).not.toBe(requests[0].headers["idempotency-key"]);
});

it("ignores late dataset responses after changing the source mode", async () => {
  const old = pending();
  let hold = false;
  mocks.fetch.mockImplementation((url: string) => hold && String(url).includes("source=internet") ? old.promise : Promise.resolve(reply(dataset(url))));
  render(<TrendsPage />);
  await screen.findByText("Начни с темы");
  fireEvent.click(screen.getByRole("tab", { name: "Мои конкуренты" }));
  await screen.findByRole("heading", { name: "Все темы" });
  hold = true;
  fireEvent.click(screen.getByRole("tab", { name: "Поиск по теме" }));
  fireEvent.click(screen.getByRole("tab", { name: "Мои конкуренты" }));
  await screen.findByRole("heading", { name: "Все темы" });
  await act(async () => old.resolve(reply({ ...dataset("?run=999"), sourceLabel: "STALE" })));
  expect(screen.queryByText(/STALE/)).toBeNull();
  expect(window.location.search).not.toContain("run=999");
});
