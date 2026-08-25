import { describe, expect, it } from "vitest";

import {
  appendToastStack,
  MAX_VISIBLE_TOASTS,
  stableToastDedupeKey,
  type ToastStackItem,
} from "./toast-stack";

function toast(id: string, kind: ToastStackItem["kind"] = "info"): ToastStackItem {
  return { id, kind, title: `Toast ${id}`, dedupeKey: id };
}

describe("toast stack", () => {
  it("deduplicates an active toast by a stable semantic key", () => {
    const active = [{ ...toast("first", "danger"), dedupeKey: "draft:41:blocked" }];
    const repeated = { ...toast("second", "danger"), dedupeKey: "draft:41:blocked" };
    expect(appendToastStack(active, repeated)).toEqual(active);
  });

  it("deduplicates byte-identical feedback even when the caller omits a key", () => {
    const key = stableToastDedupeKey({ kind: "danger", title: "Не сохранено", body: "Повтори попытку" });
    expect(key).toBe(stableToastDedupeKey({ kind: "danger", title: "Не сохранено", body: "Повтори попытку" }));
  });

  it("caps the visible stack and preserves unresolved danger messages over routine feedback", () => {
    const danger = [toast("a", "danger"), toast("b", "danger"), toast("c", "danger")];
    expect(appendToastStack(danger, toast("routine"))).toEqual(danger);
    const next = appendToastStack(danger, toast("d", "danger"));
    expect(next).toHaveLength(MAX_VISIBLE_TOASTS);
    expect(next.map((item) => item.id)).toEqual(["b", "c", "d"]);
  });
});
