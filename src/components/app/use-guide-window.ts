"use client";

import { useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { defaultGuideWindow, fitGuideWindow, GUIDE_WINDOW_STORAGE_KEY, readGuideWindow, resizeGuideWindow, type GuideBounds, type GuideRect } from "@/lib/guide-window";

type Gesture = { pointerId: number; mode: "move" | "resize" | "resize-start"; x: number; y: number; start: GuideRect; preferred: GuideRect; target: HTMLElement };

export function useGuideWindow(collapsed: boolean) {
  const stageRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const preferred = useRef<GuideRect | null>(null);
  const current = useRef<GuideRect | null>(null);
  const bounds = useRef<GuideBounds | null>(null);
  const [rect, setRect] = useState<GuideRect | null>(null);
  const [interaction, setInteraction] = useState<"move" | "resize" | "resize-start" | null>(null);
  const [announcement, setAnnouncement] = useState("");

  function persist(value: GuideRect) {
    preferred.current = value;
    try { localStorage.setItem(GUIDE_WINDOW_STORAGE_KEY, JSON.stringify(value)); } catch { /* Window controls also work with storage disabled. */ }
  }

  useLayoutEffect(() => {
    try { preferred.current = readGuideWindow(localStorage.getItem(GUIDE_WINDOW_STORAGE_KEY)); } catch {}
    let frame = 0;
    const measure = () => {
      const stage = stageRef.current?.getBoundingClientRect();
      if (!stage || !stage.width || !stage.height) return;
      const viewport = window.visualViewport;
      const x = Math.max(0, (viewport?.offsetLeft ?? 0) - stage.left);
      const y = Math.max(0, (viewport?.offsetTop ?? 0) - stage.top);
      const right = Math.min(stage.width, (viewport ? viewport.offsetLeft + viewport.width : window.innerWidth) - stage.left);
      const bottom = Math.min(stage.height, (viewport ? viewport.offsetTop + viewport.height : window.innerHeight) - stage.top);
      const nextBounds = { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) };
      bounds.current = nextBounds;
      const value = fitGuideWindow((gesture.current ? current.current : preferred.current) ?? defaultGuideWindow(nextBounds), nextBounds, collapsed ? headerRef.current?.getBoundingClientRect().height ?? 80 : undefined);
      current.current = value;
      setRect(value);
    };
    const scheduleMeasure = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); };
    // Clamp measured geometry before paint so restoring never flashes off-screen.
    measure();
    const observer = new ResizeObserver(scheduleMeasure);
    if (stageRef.current) observer.observe(stageRef.current);
    if (headerRef.current) observer.observe(headerRef.current);
    window.addEventListener("resize", scheduleMeasure);
    window.visualViewport?.addEventListener("resize", scheduleMeasure);
    window.visualViewport?.addEventListener("scroll", scheduleMeasure);
    return () => {
      cancelAnimationFrame(frame); observer.disconnect();
      window.removeEventListener("resize", scheduleMeasure);
      window.visualViewport?.removeEventListener("resize", scheduleMeasure);
      window.visualViewport?.removeEventListener("scroll", scheduleMeasure);
      const active = gesture.current;
      gesture.current = null;
      if (active?.target.hasPointerCapture(active.pointerId)) active.target.releasePointerCapture(active.pointerId);
    };
  }, [collapsed]);

  function update(value: GuideRect, save = false) {
    if (!bounds.current) return;
    const fitted = fitGuideWindow(value, bounds.current, collapsed ? headerRef.current?.getBoundingClientRect().height ?? 80 : undefined);
    current.current = fitted;
    setRect(fitted);
    if (save) persist({ ...fitted, height: collapsed ? preferred.current?.height ?? 580 : fitted.height });
  }

  function finish(cancel = false) {
    const active = gesture.current;
    if (!active) return;
    gesture.current = null;
    if (cancel) { preferred.current = active.preferred; update(active.start); }
    else if (current.current) persist({ ...current.current, height: collapsed ? active.preferred.height : current.current.height });
    if (active.target.hasPointerCapture(active.pointerId)) active.target.releasePointerCapture(active.pointerId);
    setInteraction(null);
  }

  function start(event: PointerEvent<HTMLElement>, mode: "move" | "resize" | "resize-start") {
    if (!event.isPrimary || event.button !== 0 || gesture.current || !current.current) return;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    gesture.current = { pointerId: event.pointerId, mode, x: event.clientX, y: event.clientY, start: current.current, preferred: preferred.current ?? current.current, target: event.currentTarget };
    event.currentTarget.setPointerCapture(event.pointerId);
    setInteraction(mode);
  }

  function move(event: PointerEvent<HTMLElement>) {
    const active = gesture.current;
    if (!active || active.pointerId !== event.pointerId || !bounds.current) return;
    const dx = event.clientX - active.x; const dy = event.clientY - active.y;
    update(active.mode === "move" ? { ...active.start, x: active.start.x + dx, y: active.start.y + dy }
      : resizeGuideWindow(active.start, dx, dy, active.mode === "resize-start", bounds.current));
  }

  function reset() {
    finish(true);
    if (!bounds.current) return;
    try { localStorage.removeItem(GUIDE_WINDOW_STORAGE_KEY); } catch {}
    preferred.current = null;
    update(defaultGuideWindow(bounds.current));
    setAnnouncement("Исходные размер и положение окна восстановлены.");
  }

  function onKeyDown(event: KeyboardEvent<HTMLElement>, mode: "move" | "resize") {
    const value = current.current;
    if (!value || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === "Home") { event.preventDefault(); reset(); return; }
    const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
    if (!direction) return;
    event.preventDefault(); event.stopPropagation();
    const amount = event.shiftKey ? 40 : 10;
    update(mode === "move" ? { ...value, x: value.x + direction[0] * amount, y: value.y + direction[1] * amount }
      : { ...value, width: value.width + direction[0] * amount, height: value.height + direction[1] * amount }, true);
    const result = current.current!;
    setAnnouncement(mode === "move" ? `Положение окна: ${Math.round(result.x)} по горизонтали, ${Math.round(result.y)} по вертикали.` : `Размер окна: ${Math.round(result.width)} на ${Math.round(result.height)} пикселей.`);
  }

  return { stageRef, headerRef, rect, interaction, announcement, start, reset, onKeyDown,
    pointerHandlers: {
      onPointerMove: move,
      onPointerUp: (event: PointerEvent<HTMLElement>) => { if (gesture.current?.pointerId === event.pointerId) finish(); },
      onPointerCancel: (event: PointerEvent<HTMLElement>) => { if (gesture.current?.pointerId === event.pointerId) finish(true); },
      onLostPointerCapture: (event: PointerEvent<HTMLElement>) => { if (gesture.current?.pointerId === event.pointerId) finish(true); },
    },
    cancelGesture: () => { if (!gesture.current) return false; finish(true); return true; },
  };
}
