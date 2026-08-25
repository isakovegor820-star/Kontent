import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const toaster = readFileSync(new URL("./toaster.tsx", import.meta.url), "utf8");
const store = readFileSync(new URL("../../lib/store.tsx", import.meta.url), "utf8");
const stack = readFileSync(new URL("../../lib/toast-stack.ts", import.meta.url), "utf8");

describe("Toaster interaction contract", () => {
  it("pauses non-critical dismissal while the toast is hovered or focused", () => {
    expect(toaster).toContain("onMouseEnter={pauseTimer}");
    expect(toaster).toContain("onMouseLeave={resumeTimer}");
    expect(toaster).toContain("onFocusCapture={pauseTimer}");
    expect(toaster).toContain("remainingRef.current");
  });

  it("keeps danger messages until explicit dismissal", () => {
    expect(toaster).toContain('if (toast.kind === "danger"');
    expect(toaster).toContain('role={toast.kind === "danger" ? "alert" : "status"}');
    expect(store).not.toContain("}, 5000);");
  });

  it("respects reduced motion and provides a full touch target", () => {
    expect(toaster).toContain("useReducedMotion");
    expect(toaster).toContain("initial={reducedMotion ? false");
    expect(toaster).toContain("min-h-11 min-w-11");
  });

  it("deduplicates announcements and caps the visible stack at three", () => {
    expect(store).toContain("stableToastDedupeKey(t)");
    expect(store).toContain("appendToastStack(prev, next)");
    expect(stack).toContain("MAX_VISIBLE_TOASTS = 3");
    expect(stack).toContain("toast.dedupeKey === incoming.dedupeKey");
  });

  it("keeps app notifications away from sticky bottom action bars", () => {
    expect(toaster).toContain('top-[calc(env(safe-area-inset-top)+14.5rem)]');
    expect(toaster).toContain("bottom-auto");
  });
});
