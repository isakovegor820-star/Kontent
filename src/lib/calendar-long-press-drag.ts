export const CALENDAR_LONG_PRESS_DELAY_MS = 350;
export const CALENDAR_LONG_PRESS_TOLERANCE_PX = 8;

export type CalendarDragPoint = Readonly<{
  clientX: number;
  clientY: number;
}>;

type CalendarLongPressDragCallbacks = Readonly<{
  onActivate: (point: CalendarDragPoint) => boolean | void;
  onMove: (point: CalendarDragPoint) => void;
  onDrop: (point: CalendarDragPoint) => void;
  onCancel: () => void;
}>;

type PointerStart = Readonly<{
  pointerId: number;
  pointerType: string;
  isPrimary: boolean;
  point: CalendarDragPoint;
}>;

type PointerUpdate = Readonly<{
  pointerId: number;
  point: CalendarDragPoint;
}>;

export type CalendarLongPressMoveResult = "ignored" | "pending" | "cancelled" | "dragging";

export function calendarDragAutoScrollDelta(
  clientY: number,
  viewportHeight: number,
  edgeSize = 72,
  maximumStep = 24,
) {
  if (viewportHeight <= 0 || edgeSize <= 0 || maximumStep <= 0) return 0;
  if (clientY < edgeSize) {
    return -Math.ceil(maximumStep * Math.min(1, (edgeSize - clientY) / edgeSize));
  }
  if (clientY > viewportHeight - edgeSize) {
    return Math.ceil(maximumStep * Math.min(1, (clientY - viewportHeight + edgeSize) / edgeSize));
  }
  return 0;
}

type GestureSession = {
  pointerId: number;
  origin: CalendarDragPoint;
  active: boolean;
  timer: ReturnType<typeof setTimeout> | null;
};

function exceededTolerance(
  origin: CalendarDragPoint,
  point: CalendarDragPoint,
  tolerancePx: number,
) {
  const deltaX = point.clientX - origin.clientX;
  const deltaY = point.clientY - origin.clientY;
  return deltaX * deltaX + deltaY * deltaY > tolerancePx * tolerancePx;
}

/**
 * Touch and pen input do not reliably emit native HTML drag events. This controller keeps
 * the long-press timing deterministic while the React component owns pointer capture and
 * scroll locking. Mouse input deliberately stays on the browser's native drag-and-drop path.
 */
export function createCalendarLongPressDrag(
  callbacks: CalendarLongPressDragCallbacks,
  options: Readonly<{
    delayMs?: number;
    tolerancePx?: number;
  }> = {},
) {
  const delayMs = options.delayMs ?? CALENDAR_LONG_PRESS_DELAY_MS;
  const tolerancePx = options.tolerancePx ?? CALENDAR_LONG_PRESS_TOLERANCE_PX;
  let session: GestureSession | null = null;

  const clearTimer = (target: GestureSession) => {
    if (target.timer == null) return;
    clearTimeout(target.timer);
    target.timer = null;
  };

  const cancel = (notify: boolean) => {
    const current = session;
    if (!current) return false;
    clearTimer(current);
    session = null;
    if (notify && current.active) callbacks.onCancel();
    return current.active;
  };

  return {
    pointerDown(input: PointerStart) {
      if (!input.isPrimary || input.pointerType === "mouse") return false;
      cancel(true);
      const current: GestureSession = {
        pointerId: input.pointerId,
        origin: input.point,
        active: false,
        timer: null,
      };
      session = current;
      current.timer = setTimeout(() => {
        if (session !== current) return;
        current.timer = null;
        current.active = true;
        if (callbacks.onActivate(current.origin) === false) session = null;
      }, delayMs);
      return true;
    },

    pointerMove(input: PointerUpdate): CalendarLongPressMoveResult {
      const current = session;
      if (!current || current.pointerId !== input.pointerId) return "ignored";
      if (!current.active) {
        if (!exceededTolerance(current.origin, input.point, tolerancePx)) return "pending";
        cancel(false);
        return "cancelled";
      }
      callbacks.onMove(input.point);
      return "dragging";
    },

    pointerUp(input: PointerUpdate) {
      const current = session;
      if (!current || current.pointerId !== input.pointerId) return false;
      const active = current.active;
      clearTimer(current);
      session = null;
      if (active) callbacks.onDrop(input.point);
      return active;
    },

    pointerCancel(pointerId: number) {
      if (!session || session.pointerId !== pointerId) return false;
      return cancel(true);
    },

    cancel() {
      return cancel(true);
    },

    hasSession() {
      return session != null;
    },

    isActive() {
      return session?.active === true;
    },

    dispose() {
      cancel(true);
    },
  };
}
