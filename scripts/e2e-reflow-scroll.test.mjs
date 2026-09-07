import { afterEach, expect, it, vi } from "vitest";
import { assertEditorialSubmissionReflow } from "./e2e-editorial-review-coverage.mjs";
import { assertSitesEditorActionsReflow } from "./e2e-sites-coverage.mjs";

// A browser viewport resize can apply its scroll-anchor adjustment on the next frame.
// Model that observable race, while executing the helpers' real DOM callbacks and assertions.
function fixture(kind, { smooth = false, occluded = false, clipped = false, native = false, lateAnchor = false, restoreError } = {}) {
  const initialViewport = native ? null : { width: 1280, height: 900 };
  let viewport = initialViewport; let pendingReflow = false; let resizeFrames = 0;
  let prematureScroll = false; let top = 1800; let centered = false; let frames = 0;
  const viewportChanges = [];
  const label = kind === "editorial" ? "Сохранить и отправить на согласование" : "Сохранить как новую версию";
  const rect = (left = 37, right = 283, offset = 0) => ({ left, right, top: top + offset, bottom: top + offset + 54, height: 54 });
  const scroll = ({ behavior } = {}) => {
    prematureScroll = pendingReflow;
    centered = behavior === "instant" || !smooth;
    if (centered) top = 423;
  };
  const row = { getBoundingClientRect: () => rect(), scrollIntoView: scroll };
  const column = { getBoundingClientRect: () => rect(37, 283, -350), nextElementSibling: { getBoundingClientRect: () => rect(37, 116, -210) } };
  const heading = { textContent: "Согласование материала", parentElement: column };
  const section = { querySelector: () => heading };
  const card = { getBoundingClientRect: () => rect(16, 304), parentElement: { getBoundingClientRect: () => rect(16, 304) } };
  const button = (text, offset = 0) => {
    const element = { textContent: text, parentElement: row, getBoundingClientRect: () => rect(37, 283, offset),
      scrollIntoView: scroll, contains: (value) => value === "owned-control",
      querySelector: () => ({}), closest: (selector) => selector === "section" ? section : card };
    return element;
  };
  const save = button(label); const cancel = button("Отмена", 54);
  row.querySelectorAll = () => kind === "sites" ? [save, cancel] : [save];
  vi.stubGlobal("innerWidth", 320);
  vi.stubGlobal("getComputedStyle", (element) => element === column ? { flexBasis: "192px" } : { whiteSpace: "normal" });
  vi.stubGlobal("NodeFilter", { SHOW_TEXT: 4 });
  vi.stubGlobal("document", {
    documentElement: { scrollWidth: 320 }, body: { scrollWidth: 320 }, fonts: { ready: Promise.resolve() },
    elementFromPoint: (_x, y) => !occluded && y >= (lateAnchor ? 64 : 0) && y < 900 ? "owned-control" : null,
    createTreeWalker(element) { let seen = false; return { currentNode: element, nextNode() { if (seen) return false; seen = true; return true; } }; },
    createRange() { let element; return { selectNodeContents: (value) => { element = value; }, getClientRects: () => {
      if (element === heading) return [rect(37, 180, -350)];
      const control = element.getBoundingClientRect();
      return [{ left: clipped ? 0 : control.left + 8, right: control.right - 8, top: control.top + 8, bottom: control.bottom - 8 }];
    } }; },
  });
  vi.stubGlobal("requestAnimationFrame", (callback) => {
    queueMicrotask(() => {
      if (lateAnchor && ++frames === 4) top = 0;
      if (pendingReflow && ++resizeFrames === 2) {
        pendingReflow = false;
        if (prematureScroll) top = -60;
      }
      callback(resizeFrames * 16);
    });
  });
  return {
    page: {
      viewportSize: () => viewport,
      async setViewportSize(value) {
        viewportChanges.push(value);
        if (value.width === 1280 && restoreError) throw restoreError;
        viewport = value; pendingReflow = true; resizeFrames = 0; prematureScroll = false;
      },
      getByRole: () => ({ evaluate: async (callback) => callback(save), click: async options => {
        expect(options.trial).toBe(true); expect(options.force).not.toBe(true);
        if (occluded) throw new Error("persistent overlay intercepts pointer events");
        scroll({ behavior: "instant" });
      } }),
      evaluate: async (callback) => callback(),
    },
    run(page) { return kind === "editorial" ? assertEditorialSubmissionReflow(page, { label, widths: native ? null : [320, 390, 640] })
      : assertSitesEditorActionsReflow(page, { widths: [320, 390, 640] }); },
    initialViewport, viewportChanges, wasCentered: () => centered,
  };
}

afterEach(() => vi.unstubAllGlobals());

for (const kind of ["editorial", "sites"]) {
  for (const smooth of [false, true]) {
    it(`${kind}: measures a reachable target after resize anchoring with smooth=${smooth}`, async () => {
      const state = fixture(kind, { smooth });
      const result = await state.run(state.page);
      expect(result).toHaveLength(3);
      expect(state.wasCentered()).toBe(true);
      expect(state.page.viewportSize()).toEqual(state.initialViewport);
    });
  }
  for (const defect of ["occluded", "clipped"]) {
    it(`${kind}: still rejects a ${defect} target and restores the viewport`, async () => {
      const state = fixture(kind, { [defect]: true });
      await expect(state.run(state.page)).rejects.toThrow(/clipped or unreachable/);
      expect(state.page.viewportSize()).toEqual(state.initialViewport);
    });
  }
  it(`${kind}: preserves the geometry failure together with a restore failure`, async () => {
    const restoreError = new Error("owned viewport restore failure");
    const state = fixture(kind, { occluded: true, restoreError });
    const error = await state.run(state.page).catch((value) => value);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors[0].message).toMatch(/clipped or unreachable/);
    expect(error.errors[1]).toBe(restoreError);
  });
}

it("editorial: centers in the existing native viewport without replacing its geometry", async () => {
  const state = fixture("editorial", { native: true, smooth: true });
  expect(await state.run(state.page)).toHaveLength(1);
  expect(state.viewportChanges).toEqual([]);
  expect(state.page.viewportSize()).toBeNull();
});

it("editorial: establishes pointer actionability after a late anchor adjustment", async () => {
  const state = fixture("editorial", { lateAnchor: true });
  expect(await state.run(state.page)).toHaveLength(3);
  expect(state.page.viewportSize()).toEqual(state.initialViewport);
});
