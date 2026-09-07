// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArticlesPanel } from "./articles-panel";

const mocked = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("./client", async (load) => ({ ...await load<typeof import("./client")>(), requestJson: mocked.request }));
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

function article(id: number, status: string) {
  return { id, type: "audience_answer", typeLabel: "Ответ на вопрос", origin: "manual", title: `Article ${id}`, slug: `article-${id}`,
    metaDescription: null, preview: `Preview ${id}`, similarity: null, quality: null, version: 1, status, statusReason: null,
    publishedUrl: null as string | null, publishedAt: null, updatedAt: null, bodyMarkdown: `Body ${id}` };
}

async function fixture(initial = "publishing") {
  vi.stubGlobal("React", React); vi.useFakeTimers();
  let articles = [article(1, initial), article(2, "publishing")];
  let held: { promise: Promise<unknown>; resolve: (value: unknown) => void } | null = null;
  let rejectRefresh = false;
  mocked.request.mockImplementation(async (url: string) => {
    const match = url.match(/\/articles\/(\d+)$/u);
    if (!match) return { status: 200, body: { articles: structuredClone(articles) } };
    const id = Number(match[1]);
    if (id === 1 && held) return held.promise;
    if (id === 1 && rejectRefresh) return { status: 502, body: { error: "upstream_failed" } };
    return { status: 200, body: { article: structuredClone(articles.find((item) => item.id === id)) } };
  });
  const props = { siteId: 10, verified: true, hasDestinations: true, hasProfile: true, onSiteChanged: vi.fn() };
  let view!: ReturnType<typeof render>;
  await act(async () => { view = render(<ArticlesPanel {...props} />); });
  const open = async (id: number) => { await act(async () => { fireEvent.click(screen.getByRole("button", { name: new RegExp(`Article ${id}`, "u") })); }); };
  await open(1);
  return {
    open, view, props,
    row: () => articles[0],
    change: (patch: Partial<ReturnType<typeof article>>) => { articles = [{ ...articles[0], ...patch }, articles[1]]; },
    poll: async () => { await act(async () => { await vi.advanceTimersByTimeAsync(4000); }); },
    hold: () => { let resolve!: (value: unknown) => void; held = { promise: new Promise((r) => { resolve = r; }), resolve: (value) => resolve(value) }; },
    release: async () => { const value = structuredClone(articles[0]); await act(async () => { held!.resolve({ status: 200, body: { article: value } }); }); },
    fail: () => { rejectRefresh = true; },
    recover: () => { rejectRefresh = false; },
  };
}

describe("Sites selected article follows confirmed server state", () => {
  it("updates both list and opened detail after background unpublish completes", async () => {
    const f = await fixture();
    expect(screen.getAllByText("Публикуется", { exact: true })).toHaveLength(3);
    f.change({ status: "retired" }); await f.poll();
    expect(screen.getAllByText("Снят", { exact: true })).toHaveLength(2);
    expect(screen.getAllByText("Публикуется", { exact: true })).toHaveLength(1);
  });

  it("loads the generated full body before offering editor actions", async () => {
    const f = await fixture("generating");
    f.change({ status: "needs_review", bodyMarkdown: "Generated full body" }); await f.poll();
    expect(screen.getByText("Generated full body", { exact: true })).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Править" })); });
    expect((screen.getByLabelText("Текст (Markdown)") as HTMLTextAreaElement).value).toBe("Generated full body");
  });

  it("does not replace the newly selected article when an older refresh completes last", async () => {
    const f = await fixture(); f.hold(); f.change({ status: "retired" }); await f.poll();
    expect(mocked.request.mock.calls.filter(([url]) => url === "/api/sites/10/articles/1")).toHaveLength(2);
    await f.open(2); await f.release();
    expect(screen.getByRole("heading", { name: "Article 2" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Article 1" })).toBeNull();
  });

  it("does not overwrite an active edit and refreshes after editing is cancelled", async () => {
    const f = await fixture("needs_review");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Править" })); });
    await act(async () => { fireEvent.change(screen.getByLabelText("Текст (Markdown)"), { target: { value: "Unsaved human text" } }); });
    f.change({ version: 2, bodyMarkdown: "Other editor revision" }); await f.poll();
    expect((screen.getByLabelText("Текст (Markdown)") as HTMLTextAreaElement).value).toBe("Unsaved human text");
    expect(mocked.request.mock.calls.filter(([url]) => url === "/api/sites/10/articles/1")).toHaveLength(1);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Отмена" })); });
    expect(screen.getByText("Other editor revision", { exact: true })).toBeTruthy();
  });

  it("discards an in-flight detail refresh when the site changes", async () => {
    const f = await fixture(); f.hold(); f.change({ status: "retired" }); await f.poll();
    await act(async () => { f.view.rerender(<ArticlesPanel {...f.props} siteId={11} />); });
    await f.open(2); await f.release();
    expect(screen.getByRole("heading", { name: "Article 2" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Article 1" })).toBeNull();
  });

  it("does not apply a late refresh after the user begins editing", async () => {
    const f = await fixture("needs_review"); f.hold(); f.change({ version: 2, bodyMarkdown: "Remote revision" }); await f.poll();
    expect(mocked.request.mock.calls.filter(([url]) => url === "/api/sites/10/articles/1")).toHaveLength(2);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Править" })); });
    await act(async () => { fireEvent.change(screen.getByLabelText("Текст (Markdown)"), { target: { value: "Human edit during refresh" } }); });
    await f.release();
    expect((screen.getByLabelText("Текст (Markdown)") as HTMLTextAreaElement).value).toBe("Human edit during refresh");
  });

  it("reports failed refresh instead of presenting an unconfirmed terminal detail", async () => {
    const f = await fixture(); f.fail(); f.change({ status: "retired" }); await f.poll();
    expect(screen.getByRole("alert").textContent).toContain("Не удалось обновить состояние материала");
    expect(screen.getAllByText("Снят", { exact: true })).toHaveLength(1);
  });

  it("recovers selected terminal detail after a transient GET failure", async () => {
    const f = await fixture(); f.fail(); f.change({ status: "retired" }); await f.poll();
    expect(screen.getByRole("alert").textContent).toContain("Не удалось обновить состояние материала");
    f.recover(); await f.poll();
    expect(screen.getAllByText("Снят", { exact: true })).toHaveLength(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does not restart a slow detail request on unchanged list polls", async () => {
    const f = await fixture(); f.hold(); f.change({ status: "retired" }); await f.poll();
    await f.poll(); await f.poll();
    expect(mocked.request.mock.calls.filter(([url]) => url === "/api/sites/10/articles/1")).toHaveLength(2);
    await f.release();
    expect(screen.getAllByText("Снят", { exact: true })).toHaveLength(2);
  });

  it("keeps failure visible and retries at most once per four seconds", async () => {
    const f = await fixture(); f.fail(); f.change({ status: "retired" }); await f.poll();
    await act(async () => { await vi.advanceTimersByTimeAsync(3999); });
    expect(mocked.request.mock.calls.filter(([url]) => url === "/api/sites/10/articles/1")).toHaveLength(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(mocked.request.mock.calls.filter(([url]) => url === "/api/sites/10/articles/1")).toHaveLength(3);
    expect(screen.getByRole("alert").textContent).toContain("Не удалось обновить состояние материала");
    f.view.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(12000); });
    expect(mocked.request.mock.calls.filter(([url]) => url === "/api/sites/10/articles/1")).toHaveLength(3);
  });


  it("does not replace human text when a manual reread of the selected article completes late", async () => {
    const f = await fixture("needs_review"); f.hold(); await f.open(1);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Править" })); });
    await act(async () => { fireEvent.change(screen.getByLabelText("Текст (Markdown)"), { target: { value: "Human text during manual reread" } }); });
    await f.release();
    expect((screen.getByLabelText("Текст (Markdown)") as HTMLTextAreaElement).value).toBe("Human text during manual reread");
  });

  it("discards an older manual read after another article is selected", async () => {
    const f = await fixture(); f.hold(); await f.open(1); await f.open(2); await f.release();
    expect(screen.getByRole("heading", { name: "Article 2" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Article 1" })).toBeNull();
  });

  it("discards an older manual read after the site changes", async () => {
    const f = await fixture(); f.hold(); await f.open(1);
    await act(async () => { f.view.rerender(<ArticlesPanel {...f.props} siteId={11} />); });
    await f.open(2); await f.release();
    expect(screen.getByRole("heading", { name: "Article 2" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Article 1" })).toBeNull();
  });


  it("preserves text typed during save ACK and uses the confirmed revision for the next save", async () => {
    const f = await fixture("needs_review");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Править" })); });
    await act(async () => { fireEvent.change(screen.getByLabelText("Текст (Markdown)"), { target: { value: "Submitted text" } }); });
    f.hold(); await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Сохранить как новую версию" })); });
    await act(async () => { fireEvent.change(screen.getByLabelText("Текст (Markdown)"), { target: { value: "Newer human text" } }); });
    f.change({ version: 2, bodyMarkdown: "Submitted text" }); await f.release();
    expect((screen.getByLabelText("Текст (Markdown)") as HTMLTextAreaElement).value).toBe("Newer human text");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Сохранить как новую версию" })); });
    const calls = mocked.request.mock.calls as [string, RequestInit?][];
    const saves = calls.filter(([, init]) => init?.method === "PATCH");
    expect(JSON.parse(String(saves.at(-1)?.[1]?.body))).toMatchObject({ version: 2, bodyMarkdown: "Newer human text" });
  });

  it("does not reopen a cancelled editor when its save ACK arrives", async () => {
    const f = await fixture("needs_review");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Править" })); });
    f.hold(); await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Сохранить как новую версию" })); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Отмена" })); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Править" })); });
    await act(async () => { fireEvent.change(screen.getByLabelText("Текст (Markdown)"), { target: { value: "Another edit after cancellation" } }); });
    f.change({ version: 2, bodyMarkdown: "Submitted snapshot" }); await f.release();
    expect((screen.getByLabelText("Текст (Markdown)") as HTMLTextAreaElement).value).toBe("Another edit after cancellation");
  });

  it("does not reopen the saved article after selection changes", async () => {
    const f = await fixture("needs_review");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Править" })); });
    f.hold(); await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Сохранить как новую версию" })); });
    await f.open(2); f.change({ version: 2 }); await f.release();
    expect(screen.getByRole("heading", { name: "Article 2" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Article 1" })).toBeNull();
  });

it("preserves edits accepted while article approval acknowledgment is pending", async () => {
 const f = await fixture("needs_review"); f.hold();
 await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Одобрить" })); });
 await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Править" })); });
 await act(async () => { fireEvent.change(screen.getByLabelText("Текст (Markdown)"), { target: { value: "Human changes typed during approval" } }); });
 f.change({ status: "approved" }); await f.release();
 expect((screen.getByLabelText("Текст (Markdown)") as HTMLTextAreaElement).value).toBe("Human changes typed during approval");
});

it("preserves the next brief typed while manual article creation acknowledgment is pending", async () => {
 vi.stubGlobal("React", React); vi.useFakeTimers();
 let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
 mocked.request.mockImplementation(async (_url: string, init?: RequestInit) => {
   if (init?.method === "POST") { await gate; return { status: 201, body: { ok: true } }; }
   return { status: 200, body: { articles: [] } };
 });
 await act(async () => { render(<ArticlesPanel siteId={10} verified hasDestinations hasProfile onSiteChanged={vi.fn()} />); });
 const brief = screen.getByLabelText("О чём написать") as HTMLInputElement;
 await act(async () => { fireEvent.change(brief, { target: { value: "First submitted article brief" } }); });
 await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Создать" })); });
 await act(async () => { fireEvent.change(brief, { target: { value: "Next human brief typed while creation is pending" } }); });
 await act(async () => { release(); });
 expect(brief.value).toBe("Next human brief typed while creation is pending");
});




  it("finishes an unchanged edit from the full confirmed PATCH revision", async () => {
    const f = await fixture("needs_review");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Править" })); });
    await act(async () => { fireEvent.change(screen.getByLabelText("Текст (Markdown)"), { target: { value: "Submitted text" } }); });
    f.hold(); await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Сохранить как новую версию" })); });
    f.change({ version: 2, bodyMarkdown: "Submitted text" }); await f.release();
    expect(screen.queryByLabelText("Текст (Markdown)")).toBeNull();
    expect(screen.getByText("Submitted text", { exact: true })).toBeTruthy();
    expect(mocked.request.mock.calls.filter(([url]) => url === "/api/sites/10/articles/1")).toHaveLength(2);
  });

  it("ignores a save ACK from a prior site and makes no follow-up requests after unmount", async () => {
    const f = await fixture("needs_review");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Править" })); });
    f.hold(); await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Сохранить как новую версию" })); });
    await act(async () => { f.view.rerender(<ArticlesPanel {...f.props} siteId={11} />); });
    await f.open(2); f.change({ version: 2 }); await f.release();
    expect(screen.getByRole("heading", { name: "Article 2" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Article 1" })).toBeNull();
    const calls = mocked.request.mock.calls.length; f.view.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(12000); });
    expect(mocked.request.mock.calls).toHaveLength(calls);
  });


  it("does not authorize the old server revision while an unsaved revision is displayed", async () => {
    const f = await fixture("needs_review");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Править" })); });
    await act(async () => { fireEvent.change(screen.getByLabelText("Текст (Markdown)"), { target: { value: "Unsaved reviewed revision" } }); });
    const approval = screen.getByRole("button", { name: "Одобрить" }) as HTMLButtonElement;
    expect(approval.disabled).toBe(true);
    await act(async () => { approval.click(); });
    expect(mocked.request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    expect((screen.getByRole("button", { name: "Отклонить" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Отмена" })); });
    const review = screen.getByRole("button", { name: "Одобрить" }) as HTMLButtonElement;
    expect(review.disabled).toBe(false);
    await act(async () => { review.click(); });
    expect(mocked.request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(f.props.onSiteChanged).toHaveBeenCalledOnce();
  });

  it("does not publish a previously approved revision while its editor is open", async () => {
    await fixture("approved");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Править" })); });
    expect((screen.getByRole("button", { name: "Опубликовать" }) as HTMLButtonElement).disabled).toBe(true);
  });


  it.each(["Одобрить", "Сохранить как новую версию"])("does not start a follow-up request after unmount during pending %s ACK", async (action) => {
    const f = await fixture("needs_review");
    if (action !== "Одобрить") await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Править" })); });
    f.hold(); await act(async () => { fireEvent.click(screen.getByRole("button", { name: action })); });
    const count = mocked.request.mock.calls.length;
    f.view.unmount(); await f.release();
    expect(mocked.request.mock.calls).toHaveLength(count);
    expect(f.props.onSiteChanged).not.toHaveBeenCalled();
  });

});
