// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import StudioPage from "./page";
import { AI_USAGE_FINALIZATION_RECOVERY_RU } from "@/lib/ai-client-recovery";
import { serializeStudioChatSession } from "@/lib/studio-chat-session";
import { setProjectTransport } from "@/lib/project-transport";
import { projectJson } from "@/test/project-response";

const mocks = vi.hoisted(() => ({
  search: new URLSearchParams("mode=chat"),
  routerPush: vi.fn(),
  store: { user: { id: 7 }, authReady: true, ready: true, aiUsageStatus: "ok", aiUsed: 0, aiLimit: 30,
    realChannels: [{ id: 42, title: "Тестовый канал", network: "tg", is_active: true }],
    toast: vi.fn(), refreshAiUsage: vi.fn() },
}));
vi.mock("next/navigation", () => ({ useSearchParams: () => mocks.search, useRouter: () => ({ push: mocks.routerPush }) }));
vi.mock("@/lib/store", () => ({ useStore: () => mocks.store }));
vi.mock("@/components/app/project-provider", () => ({
  useProjects: () => ({ current: { id: 7, role: "owner", personal: false } }),
}));
vi.mock("@/components/app/shell", () => ({ AppShell: ({ children }: { children: ReactNode }) => <main>{children}</main> }));
vi.mock("@/components/studio/media-generator", () => ({ MediaGenerator: () => null }));
vi.mock("@/components/studio/post-settings-menu", () => ({ PostSettingsMenu: () => null }));

beforeEach(() => {
  vi.clearAllMocks();
  setProjectTransport(7, true, 7);
  for (const key of ["localStorage", "sessionStorage"]) {
    vi.stubGlobal(key, { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() });
  }
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
});
afterEach(() => { cleanup(); setProjectTransport(null); vi.unstubAllGlobals(); });

describe("Studio message actions", () => {
  it("hides the technical persistence warning without removing recovery actions", async () => {
    const source = "Черновик поста, который модель уже успела сгенерировать.";
    const session = JSON.parse(serializeStudioChatSession(7, {
      messages: [{
        id: "legacy-finalization-warning",
        role: "ai",
        text: source,
        postable: false,
        reviewable: false,
        retryable: true,
        interrupted: true,
        errorMessage: AI_USAGE_FINALIZATION_RECOVERY_RU,
      }],
      draft: "",
      workspaceMode: "chat",
      generations: [],
    }));
    const fetch = vi.fn(async (url: string) => {
      if (url === "/api/studio/session") return projectJson(7, { session, revision: 1 });
      if (url === "/api/settings") return Response.json({ postSettings: { qualityMode: "fast" } });
      if (url === "/api/ai/engines") return Response.json({ engines: [], current: null });
      throw new Error(`Unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetch);

    render(<StudioPage />);

    await screen.findByText(source);
    expect(screen.queryByText(AI_USAGE_FINALIZATION_RECOVERY_RU)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "Повторить запрос" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Скопировать черновик" })).toBeTruthy();
  });

  it.each(["Короче", "Улучшить"])("%s sends the selected message and excludes unrelated chat history", async (label) => {
    const source = "Тестовый черновик: встреча клуба 20 сентября в 18:00. Вход бесплатный.";
    const session = JSON.parse(serializeStudioChatSession(7, {
      messages: [
        { id: "old", role: "ai", text: source, postable: true, reviewable: true },
        { id: "new", role: "ai", text: "Другой материал про банковские документы.", postable: true, reviewable: true },
      ], draft: "", workspaceMode: "chat", generations: [],
    }));
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/studio/session") return projectJson(7, { session, revision: 1 });
      if (url === "/api/settings") return Response.json({ postSettings: { qualityMode: "fast" } });
      if (url === "/api/ai/engines") return Response.json({ engines: [], current: null });
      if (url === "/api/ai/generate") return projectJson(7, { error: "provider_timeout" }, { status: 503 });
      throw new Error(`Unexpected request ${url} ${init?.method}`);
    });
    vi.stubGlobal("fetch", fetch);
    render(<StudioPage />);
    await screen.findByText(source);
    fireEvent.click(screen.getAllByRole("button", { name: label })[0]);
    await waitFor(() => expect(fetch.mock.calls.some(([url]) => url === "/api/ai/generate")).toBe(true));
    const call = fetch.mock.calls.find(([url]) => url === "/api/ai/generate")!;
    const payload = JSON.parse(String(call[1]?.body));
    expect(payload).toMatchObject({ input: source, command: label === "Короче" ? "shorten" : "rewrite", history: [] });
    expect(payload.input).not.toContain("банковские");
  });

  it("keeps all post actions after terminal acknowledgement was interrupted and recovers on demand", async () => {
    const source = "A complete English post that is already stored by the generation service.";
    const requestKey = "studio_terminal_recovery_1";
    const session = JSON.parse(serializeStudioChatSession(7, {
      messages: [{
        id: "recoverable-result",
        role: "ai",
        text: source,
        postable: false,
        reviewable: true,
        retryable: true,
        interrupted: false,
        errorMessage: AI_USAGE_FINALIZATION_RECOVERY_RU,
      }],
      draft: "",
      workspaceMode: "chat",
      generations: [["recoverable-result", {
        cmd: "rewrite",
        input: source,
        variant: 0,
        history: [],
        requestKey,
        channelId: 42,
      }]],
    }));
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/studio/session" && init?.method === "PUT") return projectJson(7, { revision: 2 });
      if (url === "/api/studio/session") return projectJson(7, { session, revision: 1 });
      if (url === "/api/settings") return Response.json({ postSettings: { qualityMode: "fast" } });
      if (url === "/api/ai/engines") return Response.json({ engines: [], current: null });
      if (url === "/api/ai/generate/ack") {
        return projectJson(7, { ok: true, generationResultId: 501 }, {
          headers: { "x-ai-acknowledged": "true" },
        });
      }
      if (url === "/api/drafts") return projectJson(7, { draft: { id: 91 }, created: true });
      throw new Error(`Unexpected request ${url} ${init?.method}`);
    });
    vi.stubGlobal("fetch", fetch);

    render(<StudioPage />);

    await screen.findByText(source);
    for (const label of ["В пост", "Скопировать", "Ещё вариант", "Улучшить", "Короче"]) {
      expect(screen.getByRole("button", { name: label })).toBeTruthy();
    }
    expect(screen.queryByRole("button", { name: "Повторить запрос" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "В пост" }));
    await waitFor(() => expect(mocks.routerPush).toHaveBeenCalledWith("/app/composer?draft=91&from=studio"));
    const ack = fetch.mock.calls.find(([url]) => url === "/api/ai/generate/ack");
    const create = fetch.mock.calls.find(([url]) => url === "/api/drafts");
    expect(new Headers(ack?.[1]?.headers).get("idempotency-key")).toBe(requestKey);
    expect(JSON.parse(String(create?.[1]?.body))).toMatchObject({
      origin: "ai",
      generationResultId: 501,
      channelIds: [42],
    });
  });

  it("clears the old variant while a new-language variant starts streaming", async () => {
    const source = "Старый русский вариант, который не должен мелькать во время новой генерации.";
    const session = JSON.parse(serializeStudioChatSession(7, {
      messages: [{ id: "variant", role: "ai", text: source, postable: true, reviewable: true }],
      draft: "",
      workspaceMode: "chat",
      generations: [["variant", {
        cmd: "write",
        input: "Write a post about product design",
        variant: 0,
        history: [],
        requestKey: "studio_variant_old_1",
        channelId: 42,
      }]],
    }));
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/studio/session" && init?.method === "PUT") return projectJson(7, { revision: 2 });
      if (url === "/api/studio/session") return projectJson(7, { session, revision: 1 });
      if (url === "/api/settings") return Response.json({ postSettings: { qualityMode: "fast", language: "en" } });
      if (url === "/api/ai/engines") return Response.json({ engines: [], current: null });
      if (url === "/api/ai/generate") return new Promise<Response>(() => {});
      throw new Error(`Unexpected request ${url} ${init?.method}`);
    });
    vi.stubGlobal("fetch", fetch);
    render(<StudioPage />);
    await screen.findByText(source);

    fireEvent.click(screen.getByRole("button", { name: "Ещё вариант" }));

    await waitFor(() => expect(screen.queryByText(source)).toBeNull());
    expect(screen.getAllByText("Готовлю новый вариант…")).toHaveLength(2);
  });
});
