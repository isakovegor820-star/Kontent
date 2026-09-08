// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ComposerPage from "./page";
import { createPostFromSource, SourcePostCreationError } from "@/lib/source-post-client";
import type { ServerDraft } from "@/lib/draft-types";
import { DRAFT_REVIEW_POLICY_VERSION } from "@/lib/draft-review";

const fixture = vi.hoisted(() => ({
  params: new URLSearchParams("draft=41"),
  router: { replace: vi.fn(), push: vi.fn() },
  store: {
    ready: true, authReady: true, realReady: true, user: { id: 1 }, posts: [],
    realChannels: [{ id: 11, network: "tg", is_active: true, title: "Право", handle: "law" }],
    toast: vi.fn(), refreshAiUsage: vi.fn(), aiUsageStatus: "ready", aiUsed: 0, aiLimit: 100,
  },
  projects: { ready: true, current: { id: 1, role: "owner", personal: true, timezone: "UTC" } },
}));
vi.mock("next/navigation", () => ({ useRouter: () => fixture.router, useSearchParams: () => fixture.params }));
vi.mock("@/lib/store", () => ({ useStore: () => fixture.store }));
vi.mock("@/components/app/project-provider", () => ({ useProjects: () => fixture.projects }));
vi.mock("@/lib/project-fetch", () => ({ projectFetch: (...args: Parameters<typeof fetch>) => fetch(...args) }));
vi.mock("@/components/app/shell", () => ({ AppShell: ({ children }: React.PropsWithChildren) => children }));
vi.mock("@/components/app/evidence-card", () => ({ EvidenceCard: () => null }));
vi.mock("@/components/app/editorial-review-panel", () => ({ EditorialReviewPanel: () => null }));
vi.mock("@/components/app/publication-followup-section", () => ({ PublicationFollowupSection: () => null }));
vi.mock("@/components/studio/media-generator", () => ({ MediaGenerator: () => null }));
vi.mock("@/components/studio/post-settings-menu", () => ({ PostSettingsMenu: () => null }));
vi.mock("@/lib/source-post-client", () => ({
  createPostFromSource: vi.fn(), SourcePostCreationError: class extends Error {},
}));
const source: ServerDraft = {
  id: 41, version: 1, text: "Исходный юридический инфоповод.", purpose: "source_context", origin: "rss",
  blocked_reason: "source_context_not_publishable", source_ref: { kind: "rss", id: "88", label: "Источник" },
  client_key: "rss_item_source:88:channel:11:variant:expert", formatting: [], media: null, scheduled_at: null,
  created_at: "2026-09-08T09:00:00Z", updated_at: "2026-09-08T09:00:00Z", editorial_state: "draft",
  generation_result_id: null, generation_binding_valid: false,
  review_policy_version: DRAFT_REVIEW_POLICY_VERSION, ai_validation: null, human_review: null,
  destinations: [{ channel_id: 11, network: "tg", is_active: true, title: "Право", handle: "law" }],
};
const generated: ServerDraft = { ...source, id: 42, text: "Новый пост, написанный ИИ.", purpose: "publishable", origin: "ai", generation_result_id: 77, generation_binding_valid: true, blocked_reason: null };
const generate = vi.mocked(createPostFromSource);
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("React", React);
  for (const name of ["localStorage", "sessionStorage"]) {
    const values = new Map<string, string>();
    vi.stubGlobal(name, {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
      key: (index: number) => [...values.keys()][index] ?? null,
      get length() { return values.size; },
    });
  }
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  HTMLElement.prototype.scrollIntoView = vi.fn();
  localStorage.clear();
  fixture.params = new URLSearchParams("draft=41");
  fixture.projects.current.role = "owner";
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    if (url === "/api/drafts/41") return Response.json({ draft: source });
    if (url === "/api/drafts/42") return Response.json({ draft: generated });
    return Response.json({});
  }));
  generate.mockResolvedValue({ draft: generated, created: true } as Awaited<ReturnType<typeof createPostFromSource>>);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("leaves a source read-only until its button is activated, then opens the generated text", async () => {
  const view = render(<ComposerPage />);
  const button = await screen.findByRole("button", { name: "Создать пост из материала" });
  expect(generate).not.toHaveBeenCalled();
  expect(screen.getByRole("textbox", { name: "Текст публикации" }).getAttribute("contenteditable")).toBe("false");
  button.focus();
  fireEvent.click(button);
  await waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(fixture.router.replace).toHaveBeenCalledWith("/app/composer?draft=42&suggestMedia=1"));
  fixture.params = new URLSearchParams("draft=42&suggestMedia=1");
  view.rerender(<ComposerPage />);
  await waitFor(() => expect(screen.getByRole("textbox", { name: "Текст публикации" }).textContent).toBe(generated.text));
  expect(screen.queryByRole("button", { name: "Создать пост из материала" })).toBeNull();
  expect(generate).toHaveBeenCalledTimes(1);
});

it("automatically starts once for the confirmed RSS create intent and blocks a second click while busy", async () => {
  fixture.params = new URLSearchParams("draft=41&intent=create");
  let finish!: (value: Awaited<ReturnType<typeof createPostFromSource>>) => void;
  generate.mockImplementation((_source, options) => {
    options.onProgress("ИИ пишет новый пост по фактам источника…");
    return new Promise((resolve) => { finish = resolve; });
  });
  render(<React.StrictMode><ComposerPage /></React.StrictMode>);
  await waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
  const button = screen.getByRole("button", { name: "Создать пост из материала" }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  expect(screen.getByText("ИИ пишет новый пост по фактам источника…").closest('[aria-live="polite"]')).not.toBeNull();
  fireEvent.click(button);
  expect(generate).toHaveBeenCalledTimes(1);
  await act(async () => finish({ draft: generated, created: true } as Awaited<ReturnType<typeof createPostFromSource>>));
  await waitFor(() => expect(fixture.router.replace).toHaveBeenCalledTimes(1));
});

it("shows an inline failure, preserves the source and waits for an explicit retry", async () => {
  fixture.params = new URLSearchParams("draft=41&intent=create");
  generate.mockRejectedValueOnce(new SourcePostCreationError("ИИ не закончил пост. Повторите создание."));
  render(<ComposerPage />);
  expect((await screen.findByRole("alert")).textContent).toContain("ИИ не закончил пост");
  expect(generate).toHaveBeenCalledTimes(1);
  expect(fixture.router.replace).not.toHaveBeenCalled();
  expect(screen.getByRole("textbox", { name: "Текст публикации" }).textContent).toBe(source.text);
  fireEvent.click(screen.getByRole("button", { name: "Повторить создание поста" }));
  await waitFor(() => expect(generate).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(fixture.router.replace).toHaveBeenCalledTimes(1));
});

it("does not generate for a publisher without content-editing permission", async () => {
  fixture.params = new URLSearchParams("draft=41&intent=create");
  fixture.projects.current.role = "publisher";
  render(<ComposerPage />);
  await screen.findByRole("heading", { name: "Это материал-источник" });
  expect(generate).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Создать пост из материала" })).toBeNull();
});
