// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import StudioPage from "./page";
import { serializeStudioChatSession } from "@/lib/studio-chat-session";
import { setProjectTransport } from "@/lib/project-transport";
import { projectJson } from "@/test/project-response";

const mocks = vi.hoisted(() => ({
  search: new URLSearchParams("mode=chat"),
  store: { user: { id: 7 }, authReady: true, ready: true, aiUsageStatus: "ok", aiUsed: 0, aiLimit: 30,
    realChannels: [{ id: 42, title: "Тестовый канал", network: "tg", is_active: true }],
    toast: vi.fn(), refreshAiUsage: vi.fn() },
}));
vi.mock("next/navigation", () => ({ useSearchParams: () => mocks.search, useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/store", () => ({ useStore: () => mocks.store }));
vi.mock("@/components/app/project-provider", () => ({
  useProjects: () => ({ current: { id: 7, role: "owner", personal: false } }),
}));
vi.mock("@/components/app/shell", () => ({ AppShell: ({ children }: { children: ReactNode }) => <main>{children}</main> }));
vi.mock("@/components/studio/media-generator", () => ({ MediaGenerator: () => null }));
vi.mock("@/components/studio/post-settings-menu", () => ({ PostSettingsMenu: () => null }));

beforeEach(() => {
  setProjectTransport(7, true, 7);
  for (const key of ["localStorage", "sessionStorage"]) {
    vi.stubGlobal(key, { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() });
  }
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
});
afterEach(() => { cleanup(); setProjectTransport(null); vi.unstubAllGlobals(); });

describe("Studio message actions", () => {
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
});
