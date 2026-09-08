// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LibraryRegistryView } from "./library-registry-view";
import type { LibraryRegistryItem } from "@/lib/library-filters";
import { appDraftActionHref } from "@/lib/app-routes";

const mocks = vi.hoisted(() => ({ push: vi.fn(), toast: vi.fn(), draft: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("@/lib/store", () => ({ useStore: () => ({ toast: mocks.toast }) }));
vi.mock("@/lib/project-fetch", () => ({ projectFetch: (...args: Parameters<typeof fetch>) => fetch(...args) }));
vi.mock("@/lib/draft-client", () => ({
  createDraftClientKey: () => "focus-draft-key",
  createLibraryServerDraft: mocks.draft,
  libraryDraftErrorMessage: () => "Попробуйте ещё раз",
}));

const text = "Первый заголовок\n\nПервый абзац.\n\nВторой абзац.\n\nПоследний абзац: весь исходный текст сохранён.";
const reference: LibraryRegistryItem = {
  id: "reference:41", kind: "reference", channelId: 11, channelTitle: "Канал", sourceId: "4",
  sourceTitle: "Источник с длинным названием", sourceUrl: "https://example.com/original/41", sourceData: "", text,
  postedAt: "2026-09-08T09:00:00Z", format: "text", saved: false, viewedAt: null, userRating: null,
  views: 3890, reactions: 8, lift: 5.64, erBayes: null, velocity: 184.1, velocityZ: 5.71,
  freshness: 0.8, analyticsScore: 94.8, formulaVersion: "v2.1", dataQuality: "high", dataMaturity: "collecting",
  isHit: true, explanation: "Объяснение из серверного ответа.",
};
const idea: LibraryRegistryItem = { ...reference, id: "idea:42", kind: "idea", text: "Другая идея\n\nПолный текст второй идеи.", sourceUrl: null };
const saved: LibraryRegistryItem = { ...reference, id: "saved:43", kind: "saved", saved: true, text: "Текст из коллекции" };
let resultItems: LibraryRegistryItem[];
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("React", React);
  HTMLElement.prototype.scrollIntoView = vi.fn();
  resultItems = [reference, idea, saved];
  mocks.draft.mockResolvedValue({ draft: { id: 91 } });
  fetchMock = vi.fn(async (url: string) => url.startsWith("/api/library/registry?")
    ? Response.json({ ok: true, items: resultItems, formulaVersion: "v2.1" })
    : Response.json({ ok: true }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function openRegistry() {
  render(<LibraryRegistryView channelId={11} channelName="Канал" />);
  return screen.findByRole("button", { name: "Читать полностью" });
}

function stateRequests() {
  return fetchMock.mock.calls.filter(([url]) => url === "/api/library/state");
}

describe("focus library with existing registry operations", () => {
  it("opens every character of the source, marks only that item viewed and restores focus when collapsed", async () => {
    const read = await openRegistry();
    expect(read.getAttribute("aria-expanded")).toBe("false");
    expect(stateRequests()).toHaveLength(0);
    fireEvent.click(read);
    const back = screen.getByRole("button", { name: "К обложке" });
    const content = document.getElementById(back.getAttribute("aria-controls")!);
    expect(content?.textContent).toBe(text);
    expect(content?.hidden).toBe(false);
    expect(document.activeElement).toBe(back);
    await waitFor(() => expect(JSON.parse(stateRequests()[0][1].body)).toMatchObject({ channelId: 11, itemType: "reference", itemId: 41, viewed: true }));
    await waitFor(() => expect(screen.getByText(/Текст · Просмотрено/)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Свернуть пост" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Читать полностью" }));
    expect(stateRequests()).toHaveLength(1);
  });

  it("keeps analytics independent of reading and does not lose explanation, formula or null metrics", async () => {
    await openRegistry();
    fireEvent.click(screen.getByText("Аналитика и ваша оценка"));
    expect(stateRequests()).toHaveLength(0);
    expect(screen.getByText("184.1")).toBeTruthy();
    expect(screen.getByText("5.71")).toBeTruthy();
    expect(screen.getByText("8")).toBeTruthy();
    fireEvent.click(screen.getByText("Как рассчитана оценка"));
    expect(screen.getByText(reference.explanation!)).toBeTruthy();
    expect(screen.getByText("Версия формулы: 2.1")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Читать полностью" }).getAttribute("aria-expanded")).toBe("false");
  });

  it("saves the reference once and preserves the original link", async () => {
    await openRegistry();
    expect(screen.getByRole("link", { name: "Открыть оригинал" }).getAttribute("href")).toBe(reference.sourceUrl);
    let finish!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }));
    const save = screen.getByRole("button", { name: "Сохранить" });
    fireEvent.click(save);
    fireEvent.click(save);
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/library/posts")).toHaveLength(1);
    expect((save as HTMLButtonElement).disabled).toBe(true);
    await act(async () => finish(Response.json({ ok: true })));
    expect((await screen.findByRole("button", { name: "Сохранено" }) as HTMLButtonElement).disabled).toBe(true);
    expect(JSON.parse(fetchMock.mock.calls.find(([url]) => url === "/api/library/posts")![1].body)).toEqual({ channelId: 11, kind: "reference", sourcePostId: 41 });
  });

  it("navigates without marking viewed, sends the selected idea to a server draft and retains the saved-item editor action", async () => {
    await openRegistry();
    expect((screen.getByRole("button", { name: "Предыдущий материал" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Следующий материал" }));
    expect(screen.getByRole("heading", { name: "Другая идея" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Сохранить" })).toBeNull();
    expect(stateRequests()).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Создать публикацию" }));
    await waitFor(() => expect(mocks.draft).toHaveBeenCalledWith({ itemKey: "idea:42", channelId: 11, clientKey: "focus-draft-key" }));
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith(appDraftActionHref("create", 91)));
    fireEvent.click(screen.getByRole("button", { name: "Следующий материал" }));
    fireEvent.click(screen.getByRole("button", { name: "Открыть в редакторе" }));
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith(appDraftActionHref("editor", 91)));
    expect((screen.getByRole("button", { name: "Следующий материал" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("sets and clears personal rating through the same item-state API", async () => {
    await openRegistry();
    fireEvent.click(screen.getByText("Аналитика и ваша оценка"));
    const star = screen.getByRole("button", { name: "Поставить оценку 4 из 5" });
    fireEvent.click(star);
    await waitFor(() => expect(star.getAttribute("aria-pressed")).toBe("true"));
    expect(JSON.parse(stateRequests()[0][1].body)).toMatchObject({ itemType: "reference", itemId: 41, channelId: 11, rating: 4, viewed: false });
    fireEvent.click(star);
    await waitFor(() => expect(star.getAttribute("aria-pressed")).toBe("false"));
    expect(JSON.parse(stateRequests()[1][1].body).rating).toBeNull();
  });

  it("keeps failed rating unchanged and allows a failed draft to be retried", async () => {
    await openRegistry();
    fireEvent.click(screen.getByText("Аналитика и ваша оценка"));
    fetchMock.mockResolvedValueOnce(Response.json({}, { status: 500 }));
    const star = screen.getByRole("button", { name: "Поставить оценку 3 из 5" });
    fireEvent.click(star);
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ kind: "danger" })));
    expect(star.getAttribute("aria-pressed")).toBe("false");
    mocks.draft.mockRejectedValueOnce(new Error("offline"));
    fireEvent.click(screen.getByRole("button", { name: "Обсудить с Авророй" }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Контекст не сохранён" })));
    expect(mocks.push).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Обсудить с Авророй" }));
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith(appDraftActionHref("discuss", 91)));
  });

  it("resolves selection after filtering and handles an empty result", async () => {
    await openRegistry();
    fireEvent.click(screen.getByRole("button", { name: "Следующий материал" }));
    resultItems = [reference];
    fireEvent.change(screen.getByRole("textbox", { name: "Поиск по реестру" }), { target: { value: "Первый" } });
    await screen.findByRole("heading", { name: "Первый заголовок" });
    expect((screen.getByRole("button", { name: "Следующий материал" }) as HTMLButtonElement).disabled).toBe(true);
    resultItems = [];
    fireEvent.change(screen.getByRole("textbox", { name: "Поиск по реестру" }), { target: { value: "ничего" } });
    expect(await screen.findByText("По этим условиям ничего нет")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Читать полностью" })).toBeNull();
  });

  it("offers retry after a failed registry load", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({}, { status: 500 }));
    render(<LibraryRegistryView channelId={11} channelName="Канал" />);
    fireEvent.click(await screen.findByRole("button", { name: "Повторить" }));
    expect(await screen.findByRole("button", { name: "Читать полностью" })).toBeTruthy();
  });
});
