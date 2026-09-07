import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { createDraftCopyId } from "@/lib/draft-outbox";

// Execute the actual hydrate callback with controlled React setters/refs. A newer
// server snapshot must not silently rebase a conflicting browser write's version.
function hydration() {
  const file = process.env.N32_COMPOSER_SOURCE ?? new URL("./page.tsx", import.meta.url);
  const source = ts.createSourceFile("page.tsx", readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callback: ts.Expression | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === "hydrate"
      && node.initializer && ts.isCallExpression(node.initializer)) callback = node.initializer.arguments[0];
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!callback) throw new Error("actual Composer hydrate callback unavailable");
  const setters: Record<string, unknown> = {};
  const values: Record<string | symbol, unknown> = {
    Date, Boolean, Number, Array, JSON, undefined,
    projectTimezone: "UTC", s: { realChannels: [] }, NETWORK_ORDER: ["tg", "vk"],
    localScheduleFieldsForInstant: () => ({ localDate: "2099-01-01", localTime: "12:00" }),
    ensureDraftClientKey: (value: string) => value,
    createDraftCopyId,
    composerTrackingFromDraft: () => ({}),
    composerAiReviewState: () => "none",
    draftReviewAssessment: () => ({ blockedReason: null }),
  };
  const scope = new Proxy(values, {
    has: () => true,
    get(target, key) {
      if (key === Symbol.unscopables) return undefined;
      if (key in target) return target[key];
      // React setters such as setSourceRef are functions even though their names
      // end in Ref; classify setters before mutable reference variables.
      if (typeof key === "string" && key.startsWith("set")) return (target[key] = (value: unknown) => { setters[key] = value; });
      if (typeof key === "string" && key.endsWith("Ref")) return (target[key] = { current: null });
      throw new Error(`unmodelled hydrate dependency: ${String(key)}`);
    },
  });
  const script = ts.transpileModule(`const hydrate = ${callback.getText(source)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  const hydrate = new Function("scope", `with(scope) { ${script}; return hydrate; }`)(scope);
  return { hydrate, setters, values };
}

const pending = {
  userId: 7, workspaceId: "project:11", clientKey: "draft_1234567890abcdef",
  copyId: "copy_inherited-1234567890", draftId: 41, baseVersion: 1, revision: 7,
  payload: { text: "Unsaved competing text", origin: "manual", channelIds: [] },
  form: { networks: [], channelIds: [], date: "2099-01-01", time: "12:00", noDate: false },
};
const draft = { id: 41, version: 2, text: "Newer saved text", destinations: [], editorial_state: "draft" };

describe("Composer recovery authority", () => {
  it("keeps a stale copy's base version and blocks autosave instead of silently rebasing on reload", () => {
    const actual = hydration();
    actual.hydrate({ ownerUserId: 7, draft, post: { text: draft.text }, pending, pendingConflict: true });
    expect(actual.setters.setText).toBe(pending.payload.text);
    expect(actual.setters.setDraftVersion).toBe(1);
    expect(actual.values.acknowledgedDraftRef).toEqual({ current: null });
    expect(actual.setters.setDraftSaveState).toBe("conflict");
  });

  it("gives duplicated editors independent writer identities while retaining the server request key", () => {
    const a = hydration(); const b = hydration();
    for (const editor of [a, b]) editor.hydrate({ ownerUserId: 7, draft, post: { text: draft.text }, pending, pendingConflict: true });
    expect(a.values.draftClientKeyRef).toEqual({ current: pending.clientKey });
    expect(b.values.draftClientKeyRef).toEqual({ current: pending.clientKey });
    const aId = (a.values.draftCopyIdRef as { current?: string } | undefined)?.current;
    const bId = (b.values.draftCopyIdRef as { current?: string } | undefined)?.current;
    expect(aId).toMatch(/^copy_/u);
    expect(bId).toMatch(/^copy_/u);
    expect(aId).not.toBe(bId);
    expect(aId).not.toBe(pending.copyId);
  });

  it("admits an explicitly chosen server version as the base for the user's next edit", () => {
    const actual = hydration();
    actual.hydrate({ ownerUserId: 7, draft, post: { text: draft.text }, pending: null });
    expect(actual.setters.setText).toBe(draft.text);
    expect(actual.setters.setDraftVersion).toBe(2);
    expect(actual.values.acknowledgedDraftRef).toEqual({ current: draft });
    expect(actual.setters.setDraftSaveState).toBe("saved");
  });
});
