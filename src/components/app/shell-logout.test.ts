import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
const source = readFileSync(process.env.N28_SHELL_SOURCE || new URL("./shell.tsx", import.meta.url), "utf8");
const parsed = ts.createSourceFile("shell.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function find(predicate: (node: ts.Node) => boolean) { let found: ts.Node | undefined; const visit = (node: ts.Node) => { if (predicate(node)) found = node; else ts.forEachChild(node, visit); }; visit(parsed); if (!found) throw new Error("Actual shell boundary missing"); return found; }
const callback = find((node) => ts.isVariableDeclaration(node) && node.name.getText(parsed) === "handleSignOut") as ts.VariableDeclaration;
const guard = find((node) => ts.isCallExpression(node) && node.expression.getText(parsed) === "useEffect" && node.arguments[0]?.getText(parsed).includes('router.replace("/login")') === true);
function run(code: string, bindings: Record<string, unknown>) { const js = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText; return new Function(...Object.keys(bindings), js)(...Object.values(bindings)); }
function fixture() { const router = { push: vi.fn(), replace: vi.fn() }; return { router, leavingRef: { current: false }, signOut: vi.fn(async () => false), useCallback: (fn: () => unknown) => fn, useEffect: (fn: () => unknown) => fn(), ready: true, authReady: true, authError: false, user: { id: 17, onboarded: true }, pathname: "/app/calendar", signOutStatus: "idle" }; }
describe("actual shell logout navigation", () => {
  it("does not navigate to the landing page before an asynchronous logout receipt", async () => {
    const f = fixture(); f.signOut.mockImplementationOnce(() => new Promise(() => {}));
    run(`const ${callback.getText(parsed)}; handleSignOut();`, f);
    expect(f.signOut).toHaveBeenCalledTimes(1); expect(f.router.push).not.toHaveBeenCalled(); expect(f.router.replace).not.toHaveBeenCalled();
  });
  it.each(["pending", "failed"])("does not navigate on %s logout", (status) => { const f = fixture(); f.signOutStatus = status; run(guard.getText(parsed), f); expect(f.router.push).not.toHaveBeenCalled(); expect(f.router.replace).not.toHaveBeenCalled(); });
  it("routes server-confirmed logout from either settings or sidebar to the intended landing page", () => { const f = fixture(); run(guard.getText(parsed), { ...f, user: null, signOutStatus: "complete" }); expect(f.router.push).toHaveBeenCalledWith("/"); expect(f.router.replace).not.toHaveBeenCalled(); });
  it("retains the ordinary expired-session login guard", () => { const f = fixture(); run(guard.getText(parsed), { ...f, user: null }); expect(f.router.replace).toHaveBeenCalledWith("/login"); expect(f.router.push).not.toHaveBeenCalled(); });
});
