export type GuideRect = { x: number; y: number; width: number; height: number };
export type GuideBounds = { x: number; y: number; width: number; height: number };
export const GUIDE_WINDOW_STORAGE_KEY = "aurora.guide-window.v1";

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));

export function fitGuideWindow(rect: GuideRect, bounds: GuideBounds, collapsedHeight?: number): GuideRect {
  const width = clamp(rect.width, Math.min(320, bounds.width), Math.min(760, bounds.width));
  const height = collapsedHeight === undefined
    ? clamp(rect.height, Math.min(320, bounds.height), Math.min(900, bounds.height))
    : Math.min(collapsedHeight, bounds.height);
  return {
    width, height,
    x: clamp(rect.x, bounds.x, bounds.x + bounds.width - width),
    y: clamp(rect.y, bounds.y, bounds.y + bounds.height - height),
  };
}

export function defaultGuideWindow(bounds: GuideBounds): GuideRect {
  return fitGuideWindow({ x: bounds.x + bounds.width - 440, y: bounds.y + bounds.height - 580, width: 440, height: 580 }, bounds);
}

export function resizeGuideWindow(rect: GuideRect, dx: number, dy: number, fromStart: boolean, bounds: GuideBounds): GuideRect {
  const availableWidth = fromStart ? rect.x + rect.width - bounds.x : bounds.x + bounds.width - rect.x;
  const availableHeight = fromStart ? rect.y + rect.height - bounds.y : bounds.y + bounds.height - rect.y;
  const width = clamp(rect.width + (fromStart ? -dx : dx), Math.min(320, bounds.width), Math.min(760, availableWidth));
  const height = clamp(rect.height + (fromStart ? -dy : dy), Math.min(320, bounds.height), Math.min(900, availableHeight));
  return { x: fromStart ? rect.x + rect.width - width : rect.x, y: fromStart ? rect.y + rect.height - height : rect.y, width, height };
}

export function readGuideWindow(value: string | null): GuideRect | null {
  try {
    const rect = JSON.parse(value ?? "null");
    if (!rect || ![rect.x, rect.y, rect.width, rect.height].every((part) => typeof part === "number" && Number.isFinite(part))) return null;
    if (rect.width <= 0 || rect.height <= 0) return null;
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  } catch { return null; }
}
