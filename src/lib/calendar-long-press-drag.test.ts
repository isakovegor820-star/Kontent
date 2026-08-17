import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CALENDAR_LONG_PRESS_DELAY_MS,
  CALENDAR_LONG_PRESS_TOLERANCE_PX,
  calendarDragAutoScrollDelta,
  createCalendarLongPressDrag,
} from "./calendar-long-press-drag";

function setup() {
  const callbacks = {
    onActivate: vi.fn(() => true),
    onMove: vi.fn(),
    onDrop: vi.fn(),
    onCancel: vi.fn(),
  };
  return { callbacks, gesture: createCalendarLongPressDrag(callbacks) };
}

describe("calendar long-press drag", () => {
  afterEach(() => vi.useRealTimers());

  it("activates touch drag only after the hold delay and then drops at the final point", () => {
    vi.useFakeTimers();
    const { callbacks, gesture } = setup();

    expect(gesture.pointerDown({
      pointerId: 7,
      pointerType: "touch",
      isPrimary: true,
      point: { clientX: 20, clientY: 40 },
    })).toBe(true);
    vi.advanceTimersByTime(CALENDAR_LONG_PRESS_DELAY_MS - 1);
    expect(callbacks.onActivate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(callbacks.onActivate).toHaveBeenCalledWith({ clientX: 20, clientY: 40 });

    expect(gesture.pointerMove({
      pointerId: 7,
      point: { clientX: 80, clientY: 140 },
    })).toBe("dragging");
    expect(callbacks.onMove).toHaveBeenCalledWith({ clientX: 80, clientY: 140 });
    expect(gesture.pointerUp({
      pointerId: 7,
      point: { clientX: 90, clientY: 160 },
    })).toBe(true);
    expect(callbacks.onDrop).toHaveBeenCalledWith({ clientX: 90, clientY: 160 });
    expect(gesture.hasSession()).toBe(false);
  });

  it("cancels a pending hold when the finger moves far enough to scroll", () => {
    vi.useFakeTimers();
    const { callbacks, gesture } = setup();
    gesture.pointerDown({
      pointerId: 9,
      pointerType: "touch",
      isPrimary: true,
      point: { clientX: 10, clientY: 10 },
    });

    expect(gesture.pointerMove({
      pointerId: 9,
      point: { clientX: 10, clientY: 10 + CALENDAR_LONG_PRESS_TOLERANCE_PX + 1 },
    })).toBe("cancelled");
    vi.runAllTimers();
    expect(callbacks.onActivate).not.toHaveBeenCalled();
    expect(callbacks.onCancel).not.toHaveBeenCalled();
  });

  it("cancels an active drag without dropping when the pointer is interrupted", () => {
    vi.useFakeTimers();
    const { callbacks, gesture } = setup();
    gesture.pointerDown({
      pointerId: 11,
      pointerType: "pen",
      isPrimary: true,
      point: { clientX: 30, clientY: 50 },
    });
    vi.advanceTimersByTime(CALENDAR_LONG_PRESS_DELAY_MS);

    expect(gesture.pointerCancel(11)).toBe(true);
    expect(callbacks.onCancel).toHaveBeenCalledOnce();
    expect(callbacks.onDrop).not.toHaveBeenCalled();
  });

  it("leaves mouse input to native drag-and-drop", () => {
    vi.useFakeTimers();
    const { callbacks, gesture } = setup();

    expect(gesture.pointerDown({
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
      point: { clientX: 0, clientY: 0 },
    })).toBe(false);
    vi.runAllTimers();
    expect(callbacks.onActivate).not.toHaveBeenCalled();
    expect(gesture.hasSession()).toBe(false);
  });

  it("scrolls only near viewport edges and keeps the direction", () => {
    expect(calendarDragAutoScrollDelta(10, 800)).toBeLessThan(0);
    expect(calendarDragAutoScrollDelta(400, 800)).toBe(0);
    expect(calendarDragAutoScrollDelta(790, 800)).toBeGreaterThan(0);
    expect(Math.abs(calendarDragAutoScrollDelta(0, 800))).toBeLessThanOrEqual(24);
    expect(Math.abs(calendarDragAutoScrollDelta(800, 800))).toBeLessThanOrEqual(24);
  });
});
