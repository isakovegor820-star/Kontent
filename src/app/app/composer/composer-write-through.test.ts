// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { afterEach, expect, it, vi } from "vitest";
import { findPendingDraft, persistPendingDraft, removePendingDraftCopy, rememberDraftCopy } from "@/lib/draft-outbox";

// Execute the actual production effect, including its guards and write result.
// Native UI tests separately exercise React mounting and the real Store poll.
const source = readFileSync(resolve("src/app/app/composer/page.tsx"), "utf8");
const tree = ts.createSourceFile("composer.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const effects: ts.Expression[] = [];
function visit(node: ts.Node) {
  if (ts.isCallExpression(node) && node.expression.getText(tree) === "useEffect"
    && node.arguments[0]?.getText(tree).includes("persistPendingDraft(")) effects.push(node.arguments[0]);
  ts.forEachChild(node, visit);
}
visit(tree);
if (effects.length !== 1) throw new Error("Actual durable write-through effect is not uniquely identified");
const code = ts.transpileModule("return (" + effects[0].getText(tree) + ")", {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

function fixture() {
  const copyId = "copy_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const failures: string[] = [];
  const values = {
    canEditContent: true, hydrated: true, composerUserId: 7, draftWorkspaceId: "project:11",
    hydratedUserIdRef: { current: 7 }, draftRevision: 4, lastSavedRevision: 3,
    draftClientKeyRef: { current: "draft_1234567890abcdef" }, draftCopyIdRef: { current: copyId },
    lastDurableDraftRef: { current: null as string | null },
    createDraftClientKey: () => { throw new Error("Existing client identity must survive"); },
    createDraftCopyId: () => { throw new Error("Existing copy identity must survive"); },
    networks: ["tg"], channelIds: [1], vkChannelIds: [], draftId: 41, draftVersion: 3,
    text: "Unsent user text", formatting: [], media: null, currentSchedule: null,
    origin: "manual", sourceRef: null, generationResultId: null, tracking: {},
    pendingComposerTracking: (value: unknown) => value, date: "", time: "12:00", noDate: false,
    persistPendingDraft, rememberDraftCopy, setDraftSaveState: (value: string) => failures.push(value),
  };
  const run = () => new Function(...Object.keys(values), code)(...Object.values(values))();
  const read = () => findPendingDraft(7, { copyId }, undefined, "project:11");
  const poll = () => {
    values.channelIds = [...values.channelIds]; values.networks = [...values.networks];
    values.tracking = { ...values.tracking }; values.formatting = [...values.formatting];
    vi.setSystemTime(new Date("2026-09-06T20:00:08Z")); run();
  };
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-09-06T20:00:00Z"));
  return { values, run, read, poll, failures };
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); localStorage.clear(); sessionStorage.clear(); });

it("an unchanged Store refresh preserves the exact copy the user selected for deletion", () => {
  const f = fixture(); f.run(); const selected = f.read()!; f.poll();
  expect(f.read()).toEqual(selected);
  expect(removePendingDraftCopy(selected)).toBe("removed");
});
it("background polling never recreates an explicitly deleted copy without a new edit", () => {
  const f = fixture(); f.run(); expect(removePendingDraftCopy(f.read()!)).toBe("removed");
  f.poll(); f.poll(); expect(f.read()).toBeNull();
});
it("a new user edit after explicit deletion remains durable", () => {
  const f = fixture(); f.run(); removePendingDraftCopy(f.read()!); f.poll();
  f.values.text = "New unsent edit"; f.values.draftRevision += 1; f.run();
  expect(f.read()?.payload.text).toBe("New unsent edit"); expect(f.read()?.revision).toBe(5);
});
for (const change of [
  { text: "Changed text at the same revision counter" }, { draftRevision: 5 }, { draftVersion: 4 },
  { date: "2026-09-07" }, { channelIds: [2] }, { tracking: { campaign: "changed" } },
  { media: { url: "/synthetic-media.png", type: "image" } },
]) {
  it(`a meaningful change invalidates the old deletion selection: ${Object.keys(change)[0]}`, () => {
    const f = fixture(); f.run(); const selected = f.read()!; Object.assign(f.values, change); f.run();
    expect(f.read()).not.toEqual(selected); expect(removePendingDraftCopy(selected)).toBe("changed");
  });
}
for (const change of [{ canEditContent: false }, { hydrated: false }, { composerUserId: 8 }]) {
  it(`never persists through an unsafe writer guard: ${Object.keys(change)[0]}`, () => {
    const f = fixture(); Object.assign(f.values, change); f.run(); expect(localStorage.length).toBe(0);
  });
}
it("a failed durable write does not suppress a later attempt of the same snapshot", async () => {
  const f = fixture(); const write = vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => { throw new DOMException("full", "QuotaExceededError"); });
  f.run(); await Promise.resolve(); expect(f.read()).toBeNull(); expect(f.failures).toEqual(["failed"]);
  write.mockRestore(); f.poll(); expect(f.read()?.payload.text).toBe("Unsent user text");
});
