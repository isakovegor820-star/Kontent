// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArticlesPanel } from "./articles-panel";
import { setProjectTransport } from "@/lib/project-transport";
import { projectJson } from "@/test/project-response";

const row = { id: 4, title: "Тестовый материал", typeLabel: "Новость", status: "generating", version: 1, updatedAt: "2026-09-08T10:00Z", bodyMarkdown: "Текст статьи", quality: null as { issues: Array<{ code: string; severity: string; message: string }> } | null };
beforeEach(() => setProjectTransport(7, true, 1));
afterEach(() => { cleanup(); setProjectTransport(null); vi.useRealTimers(); vi.unstubAllGlobals(); });
const flush = async () => { await act(async () => { await Promise.resolve(); }); };

describe("article detail recovery", () => {
  it("does not announce an empty approval queue or missing destination before data is known", async () => {
    let resolveList!: (value: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { resolveList = resolve; })));
    render(<ArticlesPanel siteId={5} verified hasDestinations={false} destinationsLoaded={false} hasProfile onSiteChanged={vi.fn()} />);
    expect(screen.getByText("Загружаем очередь материалов…")).toBeTruthy();
    expect(screen.queryByText(/На одобрении сейчас:/)).toBeNull();
    expect(screen.queryByText(/Нет настроенного назначения/)).toBeNull();
    await act(async () => { resolveList(Response.json({ articles: [] })); });
    expect(screen.getByText(/На одобрении сейчас: 0/)).toBeTruthy();
  });

  it("refreshes an open generating card to its terminal result and blocks failed quality approval", async () => {
    vi.useFakeTimers();
    let article = { ...row };
    let detailRequests = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/4")) { detailRequests++; return projectJson(7, { article }); }
      return projectJson(7, { articles: [article] });
    }));
    render(<ArticlesPanel siteId={5} verified={false} hasDestinations={false} destinationsLoaded hasProfile onSiteChanged={vi.fn()} />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /Тестовый материал/ }));
    await flush();
    article = { ...row, status: "failed", updatedAt: "2026-09-08T10:01Z", quality: { issues: [{ code: "too_short", severity: "error", message: "Недостаточно текста" }] } };
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    expect(screen.getByText("• Недостаточно текста")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Одобрить" }) as HTMLButtonElement).disabled).toBe(true);
    expect(detailRequests).toBe(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
    expect(detailRequests).toBe(2);
  });
  it("does not repeatedly reload a newer detail while the list is older", async () => {
    let detailRequests = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/4")) { detailRequests++; return projectJson(7, { article: { ...row, status: "needs_review" } }); }
      return projectJson(7, { articles: [row] });
    }));
    render(<ArticlesPanel siteId={5} verified={false} hasDestinations={false} destinationsLoaded hasProfile onSiteChanged={vi.fn()} />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /Тестовый материал/ }));
    await flush();
    await flush();
    expect(detailRequests).toBeLessThanOrEqual(2);
  });
});
