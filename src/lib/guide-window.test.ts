import { describe, expect, it } from "vitest";
import { defaultGuideWindow, fitGuideWindow, readGuideWindow, resizeGuideWindow } from "./guide-window";

describe("guide window bounds", () => {
  const desktop = { x: 0, y: 0, width: 1392, height: 852 };
  it("opens a spacious window inside the available area", () => {
    expect(defaultGuideWindow(desktop)).toEqual({ x: 952, y: 272, width: 440, height: 580 });
  });
  it("keeps all four edges reachable after dragging or growing beyond the viewport", () => {
    const fitted = fitGuideWindow({ x: -900, y: 1900, width: 2400, height: 1600 }, desktop);
    expect(fitted.x).toBeGreaterThanOrEqual(0);
    expect(fitted.y).toBeGreaterThanOrEqual(0);
    expect(fitted.x + fitted.width).toBeLessThanOrEqual(desktop.width);
    expect(fitted.y + fitted.height).toBeLessThanOrEqual(desktop.height);
  });
  it("adapts an existing desktop preference to a narrow keyboard-sized viewport", () => {
    const bounds = { x: 0, y: 120, width: 296, height: 200 };
    expect(fitGuideWindow(defaultGuideWindow(desktop), bounds)).toEqual({ x: 0, y: 120, width: 296, height: 200 });
  });
  it("keeps the header visible when a collapsed window is moved to the bottom", () => {
    const result = fitGuideWindow({ x: 2000, y: 2000, width: 440, height: 580 }, desktop, 104);
    expect(result).toEqual({ x: 952, y: 748, width: 440, height: 104 });
    expect(fitGuideWindow({ ...result, height: 580 }, desktop).y).toBe(272);
  });
  it("enforces useful minimum dimensions when the viewport permits them", () => {
    expect(fitGuideWindow({ x: 40, y: 50, width: 1, height: 1 }, desktop)).toEqual({ x: 40, y: 50, width: 320, height: 320 });
  });
  it("ignores damaged or invalid saved geometry", () => {
    for (const value of [null, "broken", "{}", '{"x":0,"y":0,"width":-1,"height":200}', '{"x":0,"y":0,"width":"400","height":200}', '{"x":1e400,"y":0,"width":400,"height":200}']) expect(readGuideWindow(value)).toBeNull();
    expect(readGuideWindow('{"x":20,"y":30,"width":440,"height":580}')).toEqual({ x: 20, y: 30, width: 440, height: 580 });
  });
  it("holds the opposite corner while growing and stops at the minimum size", () => {
    const initial = defaultGuideWindow(desktop);
    for (const delta of [-100, 2000]) {
      const resized = resizeGuideWindow(initial, delta, delta, true, desktop);
      expect(resized.x + resized.width).toBe(initial.x + initial.width);
      expect(resized.y + resized.height).toBe(initial.y + initial.height);
      expect(resized.width).toBeGreaterThanOrEqual(320);
      expect(resized.height).toBeGreaterThanOrEqual(320);
    }
    expect(resizeGuideWindow(initial, 200, 200, false, desktop)).toEqual(initial);
  });
});
