// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArticlesPanel } from "./articles-panel";

const row = { id: 4, title: "Тестовый материал", typeLabel: "Новость", status: "generating", version: 1, updatedAt: "2026-09-08T10:00Z", bodyMarkdown: "Текст статьи", quality: null as { issues: Array<{ code: string; severity: string; message: string }> } | null };
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const flush = async () => { await act(async () => { await Promise.resolve(); }); };

describe("article detail recovery", () => {
  it("refreshes an open generating card to its terminal result and blocks failed quality approval", async () => {
    vi.useFakeTimers();
    let article = { ...row };
    let detailRequests = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/4")) { detailRequests++; return Response.json({ article }); }
      return Response.json({ articles: [article] });
    }));
    render(<ArticlesPanel siteId={5} verified={false} hasDestinations={false} hasProfile onSiteChanged={vi.fn()} />);
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
      if (url.endsWith("/4")) { detailRequests++; return Response.json({ article: { ...row, status: "needs_review" } }); }
      return Response.json({ articles: [row] });
    }));
    render(<ArticlesPanel siteId={5} verified={false} hasDestinations={false} hasProfile onSiteChanged={vi.fn()} />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /Тестовый материал/ }));
    await flush();
    await flush();
    expect(detailRequests).toBeLessThanOrEqual(2);
  });
});
