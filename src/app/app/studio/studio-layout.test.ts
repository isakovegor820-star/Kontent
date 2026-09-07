import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

// Execute the actual component callbacks; the browser probe covers resulting layout.
const source = readFileSync(process.env.N31_STUDIO_SOURCE || new URL("./page.tsx", import.meta.url), "utf8");
const parsed = ts.createSourceFile("studio.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function declaration(name: string): ts.VariableDeclaration {
  let found: ts.VariableDeclaration | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(parsed) === name) found = node;
    else ts.forEachChild(node, visit);
  };
  visit(parsed);
  if (!found) throw Error(`actual Studio callback missing: ${name}`);
  return found;
}
function callback(name: string, bindings: Record<string, unknown>): (...args: unknown[]) => unknown {
  const initializer = declaration(name).initializer;
  if (!initializer) throw Error("missing initializer");
  const js = ts.transpileModule(`return ${initializer.getText(parsed)}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return new Function("useCallback", ...Object.keys(bindings), js)((fn: unknown) => fn, ...Object.values(bindings));
}
function fixture(height: number, composerHeight: number, documentTop = 182, bottom = 80) {
  let pageScroll = false;
  const window = { innerHeight: height, scrollY: 0, visualViewport: { height, offsetTop: 0 } };
  const geometry = { height: composerHeight };
  const styles = new Map<string, string>();
  const shell = {
    getBoundingClientRect: () => ({ top: documentTop - window.scrollY }),
    closest: () => ({}),
    style: { setProperty: (key: string, value: string) => styles.set(key, value) },
  };
  const fit = callback("fit", {
    window, getComputedStyle: () => ({ paddingBottom: String(bottom) }),
    shellRef: { current: shell }, designShellRef: { current: null },
    composerRef: { current: { getBoundingClientRect: () => geometry } },
    setChatPageScroll: (value: boolean) => { pageScroll = value; },
  });
  return { fit, window, geometry, styles, pageScroll: () => pageScroll };
}

describe("Studio history remains reachable in a short viewport", () => {
  it.each([221, 337])("uses document scrolling at native double zoom with composer height %i", composer => {
    const f = fixture(456, composer); f.fit();
    expect(f.pageScroll()).toBe(true);
  });
  it("keeps the existing fixed split on a sufficiently tall desktop", () => {
    const f = fixture(900, 270, 180, 40); f.fit();
    expect(f.pageScroll()).toBe(false);
    expect(f.styles.get("--studio-h")).toBe("680px");
  });
  it("responds to composer growth without requiring a viewport resize", () => {
    const f = fixture(740, 221); f.fit(); expect(f.pageScroll()).toBe(false);
    f.geometry.height = 337; f.fit(); expect(f.pageScroll()).toBe(true);
    f.geometry.height = 221; f.fit(); expect(f.pageScroll()).toBe(false);
  });
  it("does not collapse back into a fixed split while the user scrolls the document", () => {
    const f = fixture(740, 337); f.fit(); expect(f.pageScroll()).toBe(true);
    f.window.scrollY = 500; f.fit(); expect(f.pageScroll()).toBe(true);
  });
  it("releases the composer observer on unmount and observes replacement nodes", () => {
    const observers: { observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }[] = [];
    const fit = vi.fn();
    const composerRef: { current: unknown } = { current: null };
    const composerObserverRef: { current: unknown } = { current: null };
    class Observer {
      observe = vi.fn(); disconnect = vi.fn();
      constructor(readonly callback: unknown) { expect(callback).toBe(fit); observers.push(this); }
    }
    const attach = callback("attachComposer", { fit, composerRef, composerObserverRef, ResizeObserver: Observer });
    const first = {}; attach(first); expect(observers[0].observe).toHaveBeenCalledWith(first);
    attach(null); expect(observers[0].disconnect).toHaveBeenCalledOnce();
    expect(composerRef.current).toBeNull(); expect(composerObserverRef.current).toBeNull();
    attach({}); expect(observers).toHaveLength(2); expect(fit).toHaveBeenCalledTimes(2);
  });
});
