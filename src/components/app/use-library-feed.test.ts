// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LibraryRegistryItem } from "@/lib/library-filters";
import { LIBRARY_REFRESH_INTERVAL, useLibraryFeed } from "./use-library-feed";

const item = (id: string, views = 10) => ({ id, views, viewedAt: null, userRating: null, saved: false }) as LibraryRegistryItem;
const response = (items: LibraryRegistryItem[]) => ({ ok: true, json: async () => ({ ok: true, items }) });
const advance = async (time: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(time); }); };

describe("live library feed", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn());
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("refreshes metrics in place, keeps new items pending and retains local saves when showing them", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response([item("a"), item("b")]) as Response);
    const { result } = renderHook(() => useLibraryFeed("channel=1", false));
    await advance(250);
    vi.mocked(fetch).mockResolvedValueOnce(response([item("new"), item("b", 50), item("a", 30)]) as Response);
    await advance(LIBRARY_REFRESH_INTERVAL);
    expect(result.current.items.map((row) => row.id)).toEqual(["a", "b"]);
    expect(result.current.items[0].views).toBe(30);
    expect(result.current.newCount).toBe(1);
    act(() => result.current.patchItem("a", { saved: true, viewedAt: "2026-09-09T10:00:00Z" }));
    act(() => result.current.showNew());
    expect(result.current.items.map((row) => row.id)).toEqual(["new", "b", "a"]);
    expect(result.current.items[2].saved).toBe(true);
    expect(result.current.newCount).toBe(0);
  });

  it("ignores a late background response after the channel/query changes", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response([item("first")]) as Response);
    const { result, rerender } = renderHook(({ query }) => useLibraryFeed(query, false), { initialProps: { query: "channel=1" } });
    await advance(250);
    let finish!: (value: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await advance(LIBRARY_REFRESH_INTERVAL);
    const signal = vi.mocked(fetch).mock.calls.at(-1)?.[1]?.signal;
    vi.mocked(fetch).mockResolvedValueOnce(response([item("second")]) as Response);
    rerender({ query: "channel=2" });
    await advance(250);
    await act(async () => finish(response([item("stale")]) as Response));
    expect(signal?.aborted).toBe(true);
    expect(result.current.items.map((row) => row.id)).toEqual(["second"]);
  });

  it("keeps loaded cards on refresh failure and can recover without a loading skeleton", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response([item("a")]) as Response);
    const { result } = renderHook(() => useLibraryFeed("channel=1", false));
    await advance(250);
    vi.mocked(fetch).mockRejectedValueOnce(new Error("offline"));
    await act(async () => { await result.current.refresh(); });
    expect(result.current.items[0].id).toBe("a");
    expect(result.current.error).toBe(false);
    expect(result.current.refreshError).toBe(true);
    let finish!: (value: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    act(() => { void result.current.refresh(); });
    expect(result.current.loading).toBe(false);
    expect(result.current.refreshing).toBe(true);
    await act(async () => finish(response([item("new")]) as Response));
    expect(result.current.items[0].id).toBe("new");
    expect(result.current.refreshError).toBe(false);
  });

  it("does not undo a user rating with a response that started before the rating was saved", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response([item("a")]) as Response);
    const { result } = renderHook(() => useLibraryFeed("channel=1", false));
    await advance(250);
    let finish!: (value: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await advance(LIBRARY_REFRESH_INTERVAL);
    act(() => result.current.patchItem("a", { userRating: 5 }));
    await act(async () => finish(response([item("a", 500)]) as Response));
    expect(result.current.items[0]).toMatchObject({ userRating: 5, views: 500 });
  });

  it("pauses background requests while a mutation is running", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response([item("a")]) as Response);
    renderHook(() => useLibraryFeed("channel=1", true));
    await advance(250);
    await advance(LIBRARY_REFRESH_INTERVAL);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
