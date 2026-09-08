import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerDraft } from "./draft-types";
import { DEFAULT_POST_SETTINGS } from "./post-settings";
import { createPostFromSource } from "./source-post-client";
const fetchMock = vi.fn<typeof fetch>();
const source = {
  id: 41, version: 3, text: "Исходный текст новости", purpose: "source_context", origin: "rss",
  client_key: "rss_item_source:88:channel:11:variant:expert",
  source_ref: { kind: "rss", id: "88", label: "Правовой портал", factualGrounding: "curated_legal_source" },
  destinations: [{ channel_id: 11, network: "tg", is_active: true, title: "Право" }],
} as ServerDraft;
const generatedText = "Новый экспертный пост по фактам новости.";
const draft = { ...source, id: 42, text: generatedText, purpose: "publishable", origin: "ai" };

function stream(events: object[]) {
  return new Response(events.map((event) => JSON.stringify({ requestId: "r1", ...event })).join("\n") + "\n", {
    headers: { "content-type": "application/x-ndjson" },
  });
}
const terminal = [
  { type: "phase", phase: "writing" },
  { type: "delta", text: "Предварительная версия" },
  { type: "phase", phase: "editing" },
  { type: "replace", text: generatedText, pipeline: "editorial" },
  { type: "validation", status: "passed", requiresReview: false, provenance: {}, blockerCodes: [] },
  { type: "done", pipeline: "editorial", generationResultId: 77 },
];
const options = () => ({ signal: new AbortController().signal, onProgress: vi.fn() });
function responseFor(url: string) {
  if (url === "/api/settings") return Response.json({ postSettings: DEFAULT_POST_SETTINGS });
  if (url === "/api/ai/generate") return stream(terminal);
  if (url === "/api/ai/generate/ack") return Response.json({ ok: true, generationResultId: 77 }, {
    headers: { "x-ai-acknowledged": "true" },
  });
  if (url === "/api/drafts") return Response.json({ draft, created: true });
  throw new Error(`Unexpected request: ${url}`);
}
beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url) => responseFor(String(url)));
});
afterEach(() => vi.unstubAllGlobals());

describe("source → generated post", () => {
  it("generates from the owned source and selected variant, then acknowledges and saves a separate AI draft", async () => {
    const before = structuredClone(source);
    const progress = options();
    const result = await createPostFromSource(source, progress);
    expect(result.draft.id).toBe(42);
    expect(result.draft.text).toBe(generatedText);
    expect(source).toEqual(before);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/settings", "/api/ai/generate", "/api/ai/generate/ack", "/api/drafts",
    ]);
    const input = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(input).toMatchObject({
      command: "write", surface: "composer", channelId: 11,
      referenceDraftId: 41, referenceDraftVersion: 3, referenceIntent: "create",
      postSettings: { target: "telegram_channel", goal: "education", hook: "insight", requireNewAngle: true, missingFactsMode: "omit" },
    });
    expect(input).not.toHaveProperty("inputDraftId");
    expect(input).not.toHaveProperty("referenceText");
    const saved = JSON.parse(String(fetchMock.mock.calls[3][1]?.body));
    expect(saved).toMatchObject({ text: generatedText, origin: "ai", generationResultId: 77, channelIds: [11], scheduledAt: null });
    expect(progress.onProgress).toHaveBeenCalledWith("ИИ редактирует новый пост…");
    expect(progress.onProgress).toHaveBeenLastCalledWith("Сохраняем новый пост…");
  });

  it("reuses generation and draft keys after a failed save, including a new invocation after refresh", async () => {
    let failSave = true;
    fetchMock.mockImplementation(async (url) => {
      if (url === "/api/drafts" && failSave) { failSave = false; return Response.json({}, { status: 503 }); }
      return responseFor(String(url));
    });
    await expect(createPostFromSource(source, options())).rejects.toThrow();
    await createPostFromSource(structuredClone(source), options());
    const requests = fetchMock.mock.calls.filter(([url]) => url === "/api/ai/generate");
    expect(requests[0][1]?.headers).toEqual(requests[1][1]?.headers);
    expect(requests[0][1]?.body).toEqual(requests[1][1]?.body);
    const saves = fetchMock.mock.calls.filter(([url]) => url === "/api/drafts");
    expect(saves[0][1]?.body).toEqual(saves[1][1]?.body);
  });

  it.each([
    { events: terminal.slice(0, -1) },
    { events: terminal.filter((event) => event.type !== "validation") },
    { events: [...terminal, { type: "error", error: "provider_error", engine: "test", label: "test" }] },
  ])("does not acknowledge or save an incomplete or failed stream", async ({ events }) => {
    fetchMock.mockImplementation(async (url) => url === "/api/ai/generate" ? stream(events) : responseFor(String(url)));
    await expect(createPostFromSource(source, options())).rejects.toThrow("ИИ не закончил пост");
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/settings", "/api/ai/generate"]);
  });

  it("does not create a draft when acknowledgement fails", async () => {
    fetchMock.mockImplementation(async (url) => url === "/api/ai/generate/ack"
      ? Response.json({}, { status: 503 }) : responseFor(String(url)));
    await expect(createPostFromSource(source, options())).rejects.toThrow();
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/drafts")).toBe(false);
  });

  it("does not overwrite the source when all its channels are inactive", async () => {
    await expect(createPostFromSource({ ...source, destinations: [] }, options())).rejects.toThrow("Канал отключён");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports quota exhaustion without copying the source", async () => {
    fetchMock.mockImplementation(async (url) => url === "/api/ai/generate"
      ? Response.json({}, { status: 429 }) : responseFor(String(url)));
    await expect(createPostFromSource(source, options())).rejects.toThrow("Лимит ИИ исчерпан");
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/drafts")).toBe(false);
  });

  it("does not save after navigation aborts the operation", async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation(async (url) => {
      if (url === "/api/ai/generate/ack") controller.abort();
      return responseFor(String(url));
    });
    await expect(createPostFromSource(source, { signal: controller.signal, onProgress: vi.fn() })).rejects.toThrow();
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/drafts")).toBe(false);
  });

  it("keeps different variants separate while preserving the requested channel", async () => {
    await createPostFromSource(source, options());
    await createPostFromSource({ ...source, client_key: "rss_item_source:88:channel:11:variant:short" }, options());
    const requests = fetchMock.mock.calls.filter(([url]) => url === "/api/ai/generate");
    const short = JSON.parse(String(requests[1][1]?.body));
    expect(short.postSettings.length).toBe("short");
    expect(short.channelId).toBe(11);
    expect(requests[0][1]?.headers).not.toEqual(requests[1][1]?.headers);
  });
});
