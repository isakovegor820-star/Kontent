// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LibraryRegistryItem } from "@/lib/library-filters";
import { LibraryReadingFeed } from "./library-reading-feed";

const item: LibraryRegistryItem = {
  id: "reference:31", kind: "reference", channelId: 1, channelTitle: "Канал", sourceId: "3", sourceTitle: "Источник",
  sourceUrl: "https://t.me/example/31", sourceData: "public_telegram", text: "Заголовок новости\n\nПолный текст материала.\n\nПоследний абзац.",
  postedAt: "2026-09-09T10:00:00Z", format: "text", saved: false, viewedAt: null, userRating: null,
  views: 1200, reactions: 45, lift: 1.8, erBayes: 0.02, velocity: 50, velocityZ: 0.8, freshness: 0.9,
  analyticsScore: 84, formulaVersion: "v1", dataQuality: "high", dataMaturity: "mature", isHit: false,
};
const props = () => ({ items: [item], channelId: 1, stateBusy: null, draftBusy: null, onSave: vi.fn(), onStateChange: vi.fn(), onDraft: vi.fn() });
afterEach(cleanup);

describe("library reading experience", () => {
  it("opens the entire text, traps focus, closes with Escape and restores the reading button", async () => {
    const handlers = props();
    render(<LibraryReadingFeed {...handlers} />);
    const read = screen.getByRole("button", { name: "Читать полностью" });
    read.focus();
    fireEvent.click(read);
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain(item.text);
    expect(handlers.onStateChange).toHaveBeenCalledWith(item, { viewed: true });
    const close = within(dialog).getByRole("button", { name: "Закрыть материал" });
    await waitFor(() => expect(document.activeElement).toBe(close));
    expect(document.body.style.overflow).toBe("hidden");
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Сохранить материал" }));
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.body.style.overflow).toBe("");
    expect(document.activeElement).toBe(read);
  });

  it("routes create, save and discuss through the existing source item contract", () => {
    const handlers = props();
    render(<LibraryReadingFeed {...handlers} />);
    fireEvent.click(screen.getByRole("button", { name: "Создать пост" }));
    expect(handlers.onDraft).toHaveBeenCalledWith("create", item);
    fireEvent.click(screen.getByRole("button", { name: "Сохранить материал" }));
    expect(handlers.onSave).toHaveBeenCalledWith(item);
    fireEvent.click(screen.getByRole("button", { name: "Читать полностью" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Обсудить с Авророй" }));
    expect(handlers.onDraft).toHaveBeenCalledWith("discuss", item);
    expect(within(dialog).getByRole("link", { name: "Открыть оригинал" }).getAttribute("href")).toBe(item.sourceUrl);
  });

  it("shows unknown statistics as missing and labels idea statistics as source statistics", () => {
    render(<LibraryReadingFeed {...props()} items={[{ ...item, kind: "idea", views: null, reactions: null, lift: null }]} />);
    expect(screen.getByLabelText("Статистика исходной публикации").textContent).toContain("—");
    expect(screen.getAllByText("—")).toHaveLength(3);
    expect(screen.queryByRole("button", { name: "Сохранить материал" })).toBeNull();
  });
});
