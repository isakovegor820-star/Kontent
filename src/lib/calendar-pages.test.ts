import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectCalendarPages } from "./calendar-pages";
import { calendarRange } from "./calendar-query";
import { setProjectTransport } from "./project-transport";
const json = (posts: { id: number }[], hasMore = false, nextCursor: string | null = null, projectId = 7) => new Response(JSON.stringify({ posts, hasMore, nextCursor }), { headers: { "content-type": "application/json", "x-aurora-project-id": String(projectId) } });
beforeEach(() => setProjectTransport(7, true, 1));
afterEach(() => vi.unstubAllGlobals());
describe("calendar page traversal", () => {
  it("loads every page, preserving the range and deduplicating boundary records", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json([{id:3},{id:2}],true,"next")).mockResolvedValueOnce(json([{id:2},{id:1}]));
    expect(await collectCalendarPages("/api/posts", {fetcher,selection:{view:"range",from:"2030-01-01",to:"2030-02-01"}})).toEqual([{id:3},{id:2},{id:1}]);
    expect(fetcher.mock.calls[1][0]).toBe("/api/posts?view=range&from=2030-01-01&to=2030-02-01&cursor=next");
  });
  it("rejects a failed next page rather than returning a partial collection", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json([{id:3}],true,"next")).mockResolvedValueOnce(new Response(null,{status:503}));
    await expect(collectCalendarPages("/api/posts", {fetcher})).rejects.toThrow("calendar_page_503");
  });
  it("rejects truncated contracts and repeating cursors", async () => {
    await expect(collectCalendarPages("/api/posts", {fetcher:vi.fn().mockResolvedValue(new Response('{"posts":[]}'))})).rejects.toThrow("calendar_page_invalid");
    const fetcher = vi.fn().mockImplementation(() => Promise.resolve(json([{id:3}],true,"same")));
    await expect(collectCalendarPages("/api/posts", {fetcher})).rejects.toThrow("calendar_cursor_invalid");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("keeps the captured project for the entire traversal and discards a late old page", async () => {
    let deliver!: (response: Response) => void;
    const globalFetch = vi.fn().mockResolvedValueOnce(json([{id:3}],true,"next")).mockImplementationOnce(() => new Promise<Response>(resolve => {deliver=resolve;}));
    vi.stubGlobal("fetch",globalFetch);
    const pending = collectCalendarPages("/api/posts");
    const outcome = expect(pending).rejects.toMatchObject({name:"AbortError"});
    await vi.waitFor(() => expect(globalFetch).toHaveBeenCalledTimes(2));
    setProjectTransport(8,true,1); deliver(json([{id:2}]));
    await outcome;
    expect(globalFetch.mock.calls.map(call => new Headers(call[1].headers).get("x-aurora-project-id"))).toEqual(["7","7"]);
  });
});
describe("project local calendar bounds", () => {
  it("uses 23 and 25 hour DST days", () => {
    for (const [from,to,hours] of [["2030-03-31","2030-04-01",23],["2030-10-27","2030-10-28",25]] as const) {
      const range=calendarRange(from,to,"Europe/Amsterdam");
      expect((Date.parse(range.to)-Date.parse(range.from))/3600000).toBe(hours);
    }
  });
  it("rejects invalid, empty, reversed and unbounded date ranges", () => {
    for(const [from,to] of [["2030-02-30","2030-03-01"],["2030-01-01","2030-01-01"],["2030-02-01","2030-01-01"],["2030-01-01","2031-01-01"]]) expect(()=>calendarRange(from,to,"UTC")).toThrow("invalid_calendar_query");
  });
});
