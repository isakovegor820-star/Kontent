import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

function nodeFrom(path: string, predicate: (node: ts.Node) => boolean) {
  const text = readFileSync(new URL(path, import.meta.url), "utf8");
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let found: ts.Node | undefined;
  const visit = (node: ts.Node) => {
    if (predicate(node)) found = node;
    else ts.forEachChild(node, visit);
  };
  visit(source);
  if (!found) throw new Error("Actual connection UI boundary is missing");
  return { node: found, source };
}
function evaluate(source: string, bindings: Record<string, unknown>) {
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(bindings), `${js}; return value;`)(...Object.values(bindings));
}
function errorCopy(code: string, retryAfter?: unknown): string {
  const { node, source } = nodeFrom("../app/app/onboarding/page.tsx", (node) => ts.isFunctionDeclaration(node) && node.name?.text === "connectError");
  return evaluate(`${node.getText(source)}; const value = connectError;`, {})(code, retryAfter);
}
async function connectResponse(response: Response) {
  const { node, source } = nodeFrom("./store.tsx", (node) => ts.isVariableDeclaration(node) && node.name.getText() === "connectChannel");
  const initializer = (node as ts.VariableDeclaration).initializer as ts.CallExpression;
  const refreshReal = vi.fn(async () => {});
  const connect = evaluate(`const value = ${initializer.arguments[0].getText(source)};`, { fetch: vi.fn(async () => response), refreshReal, AbortSignal });
  return { result: await connect("@synthetic_channel"), refreshReal };
}

describe("Telegram connection retry instructions", () => {
  it("shows the provider's full wait instead of promising a shorter minute", () => {
    expect(errorCopy("provider_rate_limited", 120)).toContain("120 с.");
    expect(errorCopy("provider_rate_limited", 120)).not.toContain("минуту");
  });
  it("shows the remaining application rate-limit wait", () => {
    expect(errorCopy("rate_limited", 17)).toContain("17 с.");
  });
  it.each([undefined, 0, -1, 1.5, "120", Number.POSITIVE_INFINITY])("does not invent a deadline for invalid retry metadata %s", (delay) => {
    const copy = errorCopy("provider_rate_limited", delay);
    expect(copy).toContain("Повтори позже");
    expect(copy).not.toContain("минуту");
  });
  it("preserves actionable permission instructions", () => {
    expect(errorCopy("telegram_actor_not_admin", 120)).toContain("нет права публикации");
    expect(errorCopy("provider_timeout", 120)).toContain("Telegram не успел подтвердить права");
  });
  it("keeps retry metadata through the actual client store", async () => {
    const { result, refreshReal } = await connectResponse(Response.json({ ok: false, error: "provider_rate_limited", retryAfter: 120 }, { status: 429 }));
    expect(result).toEqual({ ok: false, error: "provider_rate_limited", retryAfter: 120 });
    expect(refreshReal).not.toHaveBeenCalled();
  });
  it("retains successful connection refresh", async () => {
    const { result, refreshReal } = await connectResponse(Response.json({ ok: true, title: "Synthetic channel" }));
    expect(result).toEqual({ ok: true, title: "Synthetic channel" });
    expect(refreshReal).toHaveBeenCalledOnce();
  });
});
