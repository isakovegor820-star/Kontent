import { captureProjectFetch } from "./project-transport";
import type { CalendarSelection } from "./calendar-query";

/** Only publishes a complete collection; a failed later page must never look complete. */
export async function collectCalendarPages<T extends { id: number }>(endpoint: "/api/posts" | "/api/drafts", options: {
  selection?: CalendarSelection; signal?: AbortSignal; fetcher?: typeof fetch;
} = {}): Promise<T[]> {
  const fetcher = options.fetcher ?? captureProjectFetch();
  const query = new URLSearchParams(options.selection);
  const key = endpoint === "/api/posts" ? "posts" : "drafts";
  const records = new Map<number, T>();
  const cursors = new Set<string>();
  for (;;) {
    const suffix = query.size ? `?${query}` : "";
    const response = await fetcher(`${endpoint}${suffix}`, { cache: "no-store", signal: options.signal });
    if (!response.ok) throw new Error(`calendar_page_${response.status}`);
    const body = await response.json();
    if (!Array.isArray(body[key]) || typeof body.hasMore !== "boolean") throw new Error("calendar_page_invalid");
    for (const item of body[key] as T[]) {
      if (!Number.isSafeInteger(item.id) || item.id < 1) throw new Error("calendar_record_invalid");
      records.set(item.id, item);
    }
    if (!body.hasMore) {
      if (body.nextCursor != null) throw new Error("calendar_cursor_invalid");
      return [...records.values()];
    }
    if (!body[key].length || typeof body.nextCursor !== "string" || !body.nextCursor || cursors.has(body.nextCursor)) throw new Error("calendar_cursor_invalid");
    cursors.add(body.nextCursor);
    query.set("cursor", body.nextCursor);
  }
}

export function mergeCalendarRecords<T extends { id: number }>(...lists: T[][]): T[] {
  return [...new Map(lists.flat().map(item => [item.id, item])).values()];
}
