// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { useCallback, useEffect, useRef, useState } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mergeStudioChatSessions, parseStudioChatSession, serializeStudioChatSession, studioChatStorageKey, type StudioChatSession } from "@/lib/studio-chat-session";

const source = readFileSync(process.env.N33_STUDIO_SOURCE || resolve("src/app/app/studio/page.tsx"), "utf8");
const tree = ts.createSourceFile("studio.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function nodes(predicate: (node: ts.Node) => boolean) {
  const result: ts.Node[] = [];
  const visit = (node: ts.Node) => { if (predicate(node)) result.push(node); ts.forEachChild(node, visit); };
  visit(tree); return result;
}
const effects = nodes(n => ts.isCallExpression(n) && n.expression.getText(tree) === "useEffect");
const save = effects.find(n => n.getText(tree).includes("generations: [...genRef.current.entries()]"))!;
const hide = effects.find(n => n.getText(tree).includes("const persistOnPageHide = () =>"))!;
const persist = nodes(n => ts.isVariableDeclaration(n) && n.name.getText(tree) === "persistChatSession")[0];
const helpers = nodes(n => ts.isFunctionDeclaration(n) && ["studioSessionSnapshot", "storeStudioSnapshot", "studioDraftReceiptKey", "acknowledgeStudioSnapshot"].includes(n.name?.getText(tree) ?? ""));
function run(code: string, bindings: Record<string, unknown>) {
  return new Function(...Object.keys(bindings), ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText)(...Object.values(bindings));
}
function fixture(initial: StudioChatSession = session("base")) {
  vi.useFakeTimers();
  const calls: Array<{ expectedRevision: number; session: ReturnType<typeof payload>; keepalive: boolean }> = [];
  let current = structuredClone(initial), revision = 1, status = "saved", owner = 1;
  let latest = structuredClone(initial);
  const store = new Map<string, string>(); const page = new EventTarget();
  const box = { current: null as unknown }; const acknowledged = { current: null as unknown };
  const ownerRef = { current: 1 }; const revisionRef = { current: 1 }; const queue = { current: Promise.resolve() };
  const gens = { current: new Map(initial.generations) };
  let responseBarrier: (() => Promise<void>) | undefined;
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    const input = JSON.parse(String(init.body)); calls.push({ ...input, keepalive: init.keepalive === true });
    await responseBarrier?.();
    if (input.expectedRevision !== revision) return Response.json({ error: "revision_conflict", revision, session: payload(current) }, { status: 409 });
    current = parseStudioChatSession(JSON.stringify(input.session), 1)!; revision += 1;
    return Response.json({ revision, session: payload(current) });
  });
  const bindings = {
    mergeStudioChatSessions, parseStudioChatSession, serializeStudioChatSession, studioChatStorageKey,
    useEffect: (f: () => unknown) => f(), useCallback: (f: unknown) => f,
    sessionOwner: owner, chatSessionOwner: owner, messages: latest.messages, draft: latest.draft, workspaceMode: latest.workspaceMode,
    sessionPersistenceOwnerRef: ownerRef, sessionRevisionRef: revisionRef,
    sessionPersistenceEpochRef: { current: 1 },
    sessionSaveQueueRef: queue, sessionSaveTimerRef: { current: null }, latestSessionSnapshotRef: box,
    acknowledgedSessionSnapshotRef: acknowledged, sessionSaveInFlightRef: { current: null }, genRef: gens,
    setChatPersistenceStatus: (s: string) => { status = s; },
    setMessages: (change: (value: StudioChatSession["messages"]) => StudioChatSession["messages"]) => { latest.messages = change(latest.messages); },
    setDraft: (change: (value: string) => string) => { latest.draft = change(latest.draft); },
    fetch, window: page, localStorage: { setItem: (key: string, value: string) => store.set(key, value) }, sessionStorage: { removeItem: () => {} },
  };
  const api = run(`${helpers.map(n => n.getText(tree)).join("\n")}
    ${persist ? `const ${persist.getText(tree)};` : ""}
    ${hide.getText(tree)};
    const snapshot = typeof studioSessionSnapshot === 'function' ? studioSessionSnapshot : (owner, session) => ({owner, session, serialized: serializeStudioChatSession(owner,session)});
    return { render: (value) => { messages=value.messages; draft=value.draft; workspaceMode=value.workspaceMode; ${save.getText(tree)}; }, acknowledge: (value) => { acknowledgedSessionSnapshotRef.current=snapshot(1,value); }, hide:()=>window.dispatchEvent(new Event('pagehide')), resume:()=>{const event=new Event('pageshow');Object.defineProperty(event,'persisted',{value:true});window.dispatchEvent(event);} };`, bindings) as { render(value: StudioChatSession): void; acknowledge(value: StudioChatSession): void; hide(): void; resume(): void };
  api.acknowledge(initial); api.render(latest);
  return {
    calls, store, api, box, gens, status: () => status, current: () => current, visible: () => latest, revision: () => revision,
    remote: (value: StudioChatSession) => { current = structuredClone(value); revision += 1; },
    edit: (value: StudioChatSession) => { latest = structuredClone(value); gens.current = new Map(value.generations); api.render(latest); },
    barrier: (value: () => Promise<void>) => { responseBarrier = value; },
    switchOwner: () => { owner += 1; ownerRef.current = owner; },
    flush: async () => { await vi.advanceTimersByTimeAsync(600); await queue.current; },
    settle: async () => { await vi.advanceTimersByTimeAsync(0); await queue.current; },
  };
}
function session(...ids: string[]): StudioChatSession {
  return { messages: ids.map(id => ({ id, role: "user", text: id })), draft: "", workspaceMode: "chat", generations: [] };
}
function payload(value: StudioChatSession) { return JSON.parse(serializeStudioChatSession(1, value)); }
function barrier() { let resolve!: () => void; return { promise: new Promise<void>(r => { resolve = r; }), release: () => resolve() }; }
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("actual Studio autosave and pagehide content ownership", () => {
  it("does not write an already acknowledged snapshot on timer or repeated pagehide", async () => {
    const f = fixture(); f.api.hide(); f.api.hide(); await f.flush();
    expect(f.calls).toHaveLength(0); expect(f.revision()).toBe(1);
  });
  it("merges a conflict into DB, visible history, local recovery and genRef before acknowledging it", async () => {
    const f = fixture(); const remote = session("base", "remote"); remote.draft = "remote draft";
    remote.generations = [["remote", { cmd: "write", input: "remote input", variant: 1, history: [], requestKey: "remote-key" }]];
    f.remote(remote); f.edit(session("base", "local")); await f.flush();
    expect(f.current().messages.map(m => m.id)).toEqual(["base", "remote", "local"]);
    expect(f.visible().messages.map(m => m.id)).toEqual(["base", "remote", "local"]);
    expect(f.visible().draft).toBe("remote draft"); expect(f.gens.current.get("remote")?.requestKey).toBe("remote-key");
    expect(JSON.parse(f.store.get(studioChatStorageKey(1))!).messages.map((m: { id: string }) => m.id)).toEqual(["base", "remote", "local"]);
    f.api.hide(); await f.settle(); expect(f.calls).toHaveLength(2); expect(f.revision()).toBe(3);
    expect(f.current().messages.map(m => m.id)).toContain("remote");
    f.edit({ ...f.visible(), draft: "next normal edit" }); await f.flush();
    expect(f.current().messages.map(m => m.id)).toContain("remote"); expect(f.current().draft).toBe("next normal edit");
  });
  it("uses the newest input and live streaming metadata after an awaited conflict", async () => {
    const f = fixture(); f.remote(session("base", "remote")); f.edit(session("base", "local"));
    const gate = barrier(); f.barrier(() => gate.promise);
    await vi.advanceTimersByTimeAsync(600);
    const newer = session("base", "local", "stream"); newer.draft = "typed while saving";
    newer.messages[2] = { id: "stream", role: "ai", text: "newest partial", streaming: true, requestId: "stream-id" };
    newer.generations = [["stream", { cmd: "write", input: "new input", variant: 2, history: [], requestKey: "stable-key" }]];
    f.edit(newer); gate.release(); await f.settle();
    expect(f.visible().draft).toBe("typed while saving");
    expect(f.visible().messages.find(m => m.id === "stream")).toMatchObject({ text: "newest partial", streaming: true, requestId: "stream-id" });
    expect(f.current().draft).toBe("typed while saving");
    expect(f.current().generations.find(([id]) => id === "stream")?.[1].requestKey).toBe("stable-key");
    expect(f.current().messages.map(m => m.id)).toContain("remote");
  });
  it("preserves an intentional draft clear against a remote draft during conflict", async () => {
    const initial = session("base"); initial.draft = "old acknowledged draft"; const f = fixture(initial);
    const remote = session("base", "remote"); remote.draft = "remote draft"; f.remote(remote);
    f.edit(session("base", "local")); await f.flush(); expect(f.current().draft).toBe(""); expect(f.visible().draft).toBe("");
  });
  it("does not race pagehide against an active autosave and never marks newer input saved", async () => {
    const f = fixture(); f.edit(session("base", "local")); const gate = barrier(); f.barrier(() => gate.promise);
    await vi.advanceTimersByTimeAsync(600); const newer = session("base", "local", "newer"); newer.draft = "new input"; f.edit(newer);
    f.api.hide(); await vi.advanceTimersByTimeAsync(0); expect(f.calls).toHaveLength(1);
    gate.release(); await f.settle(); expect(f.status()).toBe("saving");
    expect(JSON.parse(f.store.get(studioChatStorageKey(1))!).draft).toBe("new input");
    f.api.resume(); await f.settle(); expect(f.calls).toHaveLength(2); expect(f.current().draft).toBe("new input");
    expect(f.status()).toBe("saved");
  });
  it("makes a dirty pagehide use the same merge protocol and keeps identical replay idle", async () => {
    const f = fixture(); f.remote(session("base", "remote")); f.edit(session("base", "local"));
    f.api.hide(); await f.settle(); expect(f.calls).toHaveLength(2); expect(f.calls.every(c => c.keepalive)).toBe(true);
    expect(f.current().messages.map(m => m.id)).toEqual(["base", "remote", "local"]);
    f.api.hide(); await f.settle(); expect(f.calls).toHaveLength(2);
  });
  it("fences the old account after an awaited response, without retry or changing the next account", async () => {
    const f = fixture(); f.remote(session("base", "remote")); f.edit(session("base", "local")); const gate = barrier(); f.barrier(() => gate.promise);
    await vi.advanceTimersByTimeAsync(600); f.switchOwner(); gate.release(); await f.settle();
    expect(f.calls).toHaveLength(1); expect(f.visible().messages.map(m => m.id)).toEqual(["base", "local"]);
  });
  it("holds repeated concurrent conflicts after two attempts and retains merged local recovery", async () => {
    const f = fixture(); f.edit(session("base", "local"));
    let count = 0; f.barrier(async () => { count += 1; f.remote(session("base", `remote-${count}`)); });
    await f.flush(); expect(f.calls).toHaveLength(2); expect(f.status()).toBe("local");
    expect(JSON.parse(f.store.get(studioChatStorageKey(1))!).messages.map((m: { id: string }) => m.id)).toEqual(["base", "remote-2", "remote-1", "local"]);
  });
});

// Execute the production hook bodies with React's actual effect order, batching and
// functional state updates. The route/PG browser probe covers the transport boundary.
function reactFixture(options: { storage?: Map<string, string>; initialDraft?: string; failWrites?: boolean } = {}) {
  const storage = options.storage ?? new Map<string, string>();
  vi.useFakeTimers();
  const server = new Map<number, { revision: number; session: StudioChatSession }>([
    [1, { revision: 1, session: { ...session("account-1-base"), draft: options.initialDraft ?? "" } }],
    [2, { revision: 1, session: session("account-2-base") }],
  ]);
  let authenticatedOwner: number | null = 1;
  let waitForWrite: (() => Promise<void>) | undefined;
  const writes: Array<{ owner: number; expectedRevision: number; session: StudioChatSession }> = [];
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
    const owner = authenticatedOwner;
    if (!owner) return Response.json({ error: "unauthorized" }, { status: 401 });
    if (!init || init.method !== "PUT") {
      const value = server.get(owner)!;
      return Response.json({ revision: value.revision, session: JSON.parse(serializeStudioChatSession(owner, value.session)) });
    }
    const input = JSON.parse(String(init.body));
    const pending = parseStudioChatSession(JSON.stringify(input.session), owner)!;
    writes.push({ owner, expectedRevision: input.expectedRevision, session: pending });
    if (options.failWrites) throw new Error("synthetic_network_failure");
    await waitForWrite?.();
    const value = server.get(owner)!;
    if (input.expectedRevision !== value.revision) {
      return Response.json({ error: "revision_conflict", revision: value.revision, session: JSON.parse(serializeStudioChatSession(owner, value.session)) }, { status: 409 });
    }
    value.revision += 1; value.session = pending;
    return Response.json({ revision: value.revision, session: input.session });
  });
  const load = effects.find(n => n.getText(tree).includes("let serverUnavailable = false"))!;
  const unmount = effects.find(n => n.getText(tree).startsWith("useEffect(() => () => {") && n.getText(tree).includes("sessionSaveTimerRef"))!;
  const refsAndOwner = source.slice(source.indexOf("  const sessionRevisionRef ="), source.indexOf("  // Both autosave and pagehide"));
  const useActualPersistence = run(`
    ${helpers.map(n => n.getText(tree)).join("\n")}
    return function useActualPersistence(owner) {
      const s = { authReady: true, user: owner ? { id: owner } : null };
      const requestedWorkspaceMode = undefined;
      const [messages, setMessages] = useState([]);
      const [draft, setDraft] = useState("");
      const [workspaceMode, setWorkspaceMode] = useState("chat");
      const [chatSessionOwner, setChatSessionOwner] = useState(null);
      const [chatPersistenceStatus, setChatPersistenceStatus] = useState("loading");
      const genRef = useRef(new Map());
      const streamRef = useRef({ current: null });
      ${refsAndOwner}
      const ${persist.getText(tree)};
      ${load.getText(tree)};
      ${save.getText(tree)};
      ${hide.getText(tree)};
      ${unmount.getText(tree)};
      return { messages, draft, status: chatPersistenceStatus, setMessages, setDraft, genRef };
    };`, {
      useState, useRef, useEffect, useCallback, fetch, mergeStudioChatSessions, parseStudioChatSession,
      serializeStudioChatSession, studioChatStorageKey, abortStudioStream: vi.fn(), window,
      localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
      sessionStorage: { getItem: () => null, removeItem: vi.fn() },
    }) as (owner: number | null) => {
      messages: StudioChatSession["messages"]; draft: string; status: string;
      setMessages: (value: StudioChatSession["messages"]) => void; setDraft: (value: string) => void;
      genRef: { current: Map<string, StudioChatSession["generations"][number][1]> };
    };
  const hook = renderHook(({ owner }: { owner: number | null }) => useActualPersistence(owner), { initialProps: { owner: 1 as number | null } });
  return {
    ...hook, writes, server,
    owner: (owner: number | null) => { authenticatedOwner = owner; hook.rerender({ owner }); },
    barrier: (value?: () => Promise<void>) => { waitForWrite = value; },
    flush: async (ms = 0) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); },
  };
}

describe("Studio persistence with actual React scheduling", () => {
  it("preserves a clear and live stream made during a conflict, with no redundant follow-up write", async () => {
    const f = reactFixture(); await f.flush();
    const remote = session("account-1-base", "remote"); remote.draft = "other tab input";
    f.server.set(1, { revision: 2, session: remote });
    const gate = barrier(); f.barrier(() => gate.promise);
    act(() => { f.result.current.setDraft("draft before save"); });
    await f.flush(600); expect(f.writes).toHaveLength(1);
    act(() => {
      f.result.current.setDraft("");
      f.result.current.setMessages([...f.result.current.messages, { id: "stream", role: "ai", text: "partial body", streaming: true, requestId: "active-stream" }]);
      f.result.current.genRef.current.set("stream", { cmd: "write", input: "live input", variant: 1, history: [], requestKey: "stable-stream-key" });
    });
    gate.release(); await f.flush(); await f.flush(600);
    expect(f.result.current.draft).toBe("");
    expect(f.result.current.messages.find(m => m.id === "stream")).toMatchObject({ streaming: true, requestId: "active-stream", text: "partial body" });
    expect(f.server.get(1)?.session.draft).toBe("");
    expect(f.server.get(1)?.session.messages.map(m => m.id)).toEqual(["account-1-base", "remote", "stream"]);
    expect(f.server.get(1)?.session.generations[0]?.[1].requestKey).toBe("stable-stream-key");
    expect(f.result.current.status).toBe("saved"); expect(f.writes).toHaveLength(2);
  });
  it("does not retry an old account's conflict after logout", async () => {
    const f = reactFixture(); await f.flush();
    f.server.set(1, { revision: 2, session: session("account-1-base", "private-remote") });
    const gate = barrier(); f.barrier(() => gate.promise);
    act(() => { f.result.current.setDraft("private pending draft"); }); await f.flush(600);
    f.owner(null); gate.release(); await f.flush();
    expect(f.writes).toHaveLength(1);
    expect(f.result.current.messages.map(m => m.id)).not.toContain("private-remote");
    expect(f.result.current.status).not.toBe("saved");
  });
  it("fences a delayed response across logout and login to the same account", async () => {
    const f = reactFixture(); await f.flush();
    const gate = barrier(); f.barrier(() => gate.promise);
    act(() => { f.result.current.setDraft("pre-logout input"); }); await f.flush(600);
    f.owner(null); f.owner(1); await f.flush();
    f.server.set(1, { revision: 2, session: session("account-1-base", "remote-after-login") });
    gate.release(); await f.flush();
    expect(f.writes).toHaveLength(1);
    expect(f.server.get(1)?.session.messages.map(m => m.id)).toContain("remote-after-login");
    expect(f.result.current.messages.map(m => m.id)).not.toContain("remote-after-login");
  });
  it("lets a new account save independently while the old account's response is held", async () => {
    const f = reactFixture(); await f.flush();
    const gate = barrier(); f.barrier(() => gate.promise);
    act(() => { f.result.current.setDraft("account 1 private input"); }); await f.flush(600);
    f.owner(2); f.barrier(); await f.flush();
    expect(f.result.current.messages.map(m => m.id)).toEqual(["account-2-base"]);
    expect(f.result.current.draft).toBe("");
    act(() => { f.result.current.setDraft("account 2 input"); }); await f.flush(600);
    expect(f.writes.map(w => w.owner)).toEqual([1, 2]);
    expect(f.server.get(2)?.session.draft).toBe("account 2 input");
    gate.release(); await f.flush();
    expect(f.result.current.messages.map(m => m.id)).toEqual(["account-2-base"]);
    expect(f.result.current.draft).toBe("account 2 input");
    expect(f.result.current.status).toBe("saved");
  });
  it("does not retry after the persistence component unmounts", async () => {
    const f = reactFixture(); await f.flush();
    f.server.set(1, { revision: 2, session: session("account-1-base", "remote") });
    const gate = barrier(); f.barrier(() => gate.promise);
    act(() => { f.result.current.setDraft("pending draft"); }); await f.flush(600);
    f.unmount(); gate.release(); await f.flush();
    expect(f.writes).toHaveLength(1);
    expect(f.server.get(1)?.revision).toBe(2);
  });
});


describe("durable Studio draft recovery", () => {
  it("retains an intentionally cleared draft after failed PUT and remount, then removes pending intent only after ACK", async () => {
    const storage = new Map<string, string>();
    const before = reactFixture({ storage, initialDraft: "Server draft explicitly cleared by user", failWrites: true });
    await before.flush();
    expect(before.result.current.draft).toBe("Server draft explicitly cleared by user");
    act(() => before.result.current.setDraft(""));
    await before.flush(600);
    expect(before.result.current.status).toBe("local");
    expect(JSON.parse(storage.get(studioChatStorageKey(1))!)).toMatchObject({ draft: "", localDraftPending: true });
    expect(before.server.get(1)?.session.draft).toBe("Server draft explicitly cleared by user");
    before.unmount();
    const after = reactFixture({ storage, initialDraft: "Server draft explicitly cleared by user" });
    await after.flush();
    expect(after.result.current.draft).toBe("");
    await after.flush(600);
    expect(after.server.get(1)?.session.draft).toBe("");
    expect(after.result.current.status).toBe("saved");
    const acknowledgedLocal = JSON.parse(storage.get(studioChatStorageKey(1))!);
    expect(storage.get(`${studioChatStorageKey(1)}:draft-ack:${acknowledgedLocal.localSnapshotId}`)).toBe("1");
    after.unmount();
    const acknowledgedReload = reactFixture({ storage, initialDraft: "Later draft written on another device" });
    await acknowledgedReload.flush();
    expect(acknowledgedReload.result.current.draft).toBe("Later draft written on another device");
  });

  it.each(["missing", "legacy empty"])("recovers remote draft with %s local recovery", async (kind) => {
    const storage = new Map<string, string>();
    if (kind === "legacy empty") storage.set(studioChatStorageKey(1), serializeStudioChatSession(1, session()));
    const f = reactFixture({ storage, initialDraft: "Remote unsaved text" });
    await f.flush();
    expect(f.result.current.draft).toBe("Remote unsaved text");
    await f.flush(600);
    expect(f.writes).toHaveLength(0);
  });

  it("does not consume another account's local clear intent", async () => {
    const storage = new Map([[studioChatStorageKey(1), JSON.stringify({ ...payload(session()), localDraftPending: true })]]);
    const f = reactFixture({ storage });
    f.server.get(2)!.session.draft = "Second account remote input";
    f.owner(2); await f.flush();
    expect(f.result.current.draft).toBe("Second account remote input");
    expect(JSON.parse(storage.get(studioChatStorageKey(1))!).localDraftPending).toBe(true);
  });
});


it("does not overwrite another tab's durable snapshot while acknowledging its own cleared draft", async () => {
  const storage = new Map<string, string>();
  const f = reactFixture({ storage, initialDraft: "Original server input" });
  await f.flush();
  const gate = barrier(); f.barrier(() => gate.promise);
  act(() => f.result.current.setDraft("")); await f.flush(600);
  const other = JSON.stringify({ ...payload({ ...session(), draft: "Other tab's newer unsaved input" }), localDraftPending: true });
  storage.set(studioChatStorageKey(1), other);
  gate.release(); await f.flush();
  expect(f.server.get(1)?.session.draft).toBe("");
  expect(storage.get(studioChatStorageKey(1))).toBe(other);
});
