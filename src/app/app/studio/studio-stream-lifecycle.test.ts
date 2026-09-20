import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { abortStudioStream, beginStudioStream, clearStudioStream, ownsStudioStream, type StudioStreamBox } from "@/lib/studio-stream-control";
import { stopStudioStreamingMessages } from "@/lib/studio-chat-session";

const source = readFileSync(process.env.N27_STUDIO_SOURCE || new URL("./page.tsx", import.meta.url), "utf8");
const parsed = ts.createSourceFile("studio.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function find<T extends ts.Node>(predicate: (node: ts.Node) => node is T): T {
  let result: T | undefined;
  const visit = (node: ts.Node) => { if (predicate(node)) result = node; else ts.forEachChild(node, visit); };
  visit(parsed);
  if (!result) throw Error("actual Studio function not found");
  return result;
}
function arrow(name: string): ts.ArrowFunction {
  const declaration = find((node): node is ts.VariableDeclaration => ts.isVariableDeclaration(node) && node.name.getText(parsed) === name);
  if (!declaration.initializer || !ts.isArrowFunction(declaration.initializer)) throw Error("actual arrow missing");
  return declaration.initializer;
}
const start = arrow("startStream");
if (!ts.isBlock(start.body)) throw Error("stream block missing");
const attempt = start.body.statements.find(ts.isTryStatement);
if (!attempt?.catchClause) throw Error("actual stream catch missing");
const catchBody = attempt.catchClause.block.getText(parsed);
const lifecycle = find((node): node is ts.CallExpression => ts.isCallExpression(node)
  && node.expression.getText(parsed) === "useEffect"
  && node.arguments[0]?.getText(parsed).includes("const box = streamRef.current;") === true);
const completed = find((node): node is ts.IfStatement => ts.isIfStatement(node)
  && node.expression.getText(parsed) === 'completion.status === "complete"');
function execute(code: string, bindings: Record<string, unknown>) {
  const js = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return new Function(...Object.keys(bindings), js)(...Object.values(bindings));
}
function fixture() {
  const box: StudioStreamBox = { current: null };
  const owner = beginStudioStream(box);
  let messages = [{ id: "a", text: "partial confirmed text", streaming: true, gen: { requestKey: "same-key" } }];
  const refreshAiUsage = vi.fn();
  const bindings = {
    err: new DOMException("cancelled", "AbortError"), id: "a", previousText: "",
    ownsStream: () => ownsStudioStream(box, owner), clearCancel: () => clearStudioStream(box, owner),
    setMessages: (change: (previous: typeof messages) => typeof messages) => { messages = change(messages); },
    isStudioGenerationPlaceholder: () => false, s: { refreshAiUsage },
  };
  return { box, owner, bindings, refreshAiUsage, messages: () => messages,
    catchFailure: () => execute(`return (async () => ${catchBody})();`, bindings) };
}

describe("actual Studio stream lifecycle", () => {
  it("does not refresh quota or touch request B when stale request A rejects", async () => {
    const f = fixture(); abortStudioStream(f.box); const next = beginStudioStream(f.box);
    await f.catchFailure();
    expect(f.refreshAiUsage).not.toHaveBeenCalled();
    expect(f.box.current).toBe(next);
    expect(f.messages()[0]).toMatchObject({ text: "partial confirmed text", streaming: true, gen: { requestKey: "same-key" } });
  });
  it("invalidates its owner on pagehide before the transport catch starts a new request", async () => {
    const f = fixture(); const page = new EventTarget(); let cleanup: (() => void) | undefined;
    execute(lifecycle.getText(parsed), { ...f.bindings, window: page, streamRef: { current: f.box }, abortStudioStream, stopStudioStreamingMessages,
      useEffect: (effect: () => () => void) => { cleanup = effect(); } });
    page.dispatchEvent(new Event("pagehide"));
    await f.catchFailure();
    expect(f.owner.controller.signal.aborted).toBe(true);
    expect(f.box.current).toBeNull();
    expect(f.refreshAiUsage).not.toHaveBeenCalled();
    expect(f.messages()[0]).toMatchObject({ text: "partial confirmed text", streaming: false, interrupted: true, retryable: true, gen: { requestKey: "same-key" } });
    cleanup?.();
  });
  it("still refreshes a mounted transport failure and preserves partial text with its request key", async () => {
    const f = fixture(); await f.catchFailure();
    expect(f.refreshAiUsage).toHaveBeenCalledOnce();
    expect(f.box.current).toBeNull();
    expect(f.messages()[0]).toMatchObject({ text: "partial confirmed text", streaming: false, interrupted: true, retryable: true, gen: { requestKey: "same-key" } });
  });
  it("explicit Stop refreshes once without giving the stale catch another network side effect", async () => {
    const f = fixture();
    execute(`return (${arrow("stop").getText(parsed)})();`, { ...f.bindings, streamRef: { current: f.box }, abortStudioStream, stopStudioStreamingMessages });
    expect(f.refreshAiUsage).toHaveBeenCalledOnce();
    await f.catchFailure();
    expect(f.refreshAiUsage).toHaveBeenCalledOnce();
    expect(f.messages()[0]).toMatchObject({ text: "partial confirmed text", streaming: false, gen: { requestKey: "same-key" } });
  });
  it.each(["success", "failure"])("ignores an acknowledgement %s after its stream owner was retired", async (outcome) => {
    const f = fixture(); let finish!: (result: { generationResultId: number }) => void; let fail!: (error: Error) => void;
    const acknowledgement = new Promise<{ generationResultId: number }>((resolve, reject) => { finish = resolve; fail = reject; });
    const openAsPost = vi.fn();
    const pending = execute(`return (async () => ${completed.thenStatement.getText(parsed)})();`, {
      ...f.bindings, requestKey: "same-key", controller: f.owner.controller,
      acknowledgeAiTerminal: () => acknowledgement, AiTerminalAckError: class extends Error {},
      terminalGenerationResultId: null, terminalRequestId: null, terminalValidation: null,
      completion: { text: "confirmed", reviewable: true }, gen: { autoOpenComposer: true },
      requestedEngineId: null, effectiveEngineId: null, engines: [], fallbackUsed: false, replayed: false,
      setMsg: vi.fn(), generationChannelId: 1, openAsPost,
    });
    abortStudioStream(f.box); const next = beginStudioStream(f.box);
    if (outcome === "success") finish({ generationResultId: 1 }); else fail(new Error("ack transport failed"));
    await pending;
    expect(openAsPost).not.toHaveBeenCalled();
    expect(f.refreshAiUsage).not.toHaveBeenCalled();
    expect(f.box.current).toBe(next);
  });
});
