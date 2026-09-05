"use client";

import { useEffect, useRef, type KeyboardEvent, type RefObject } from "react";

/** Shared modal lifecycle: inert background, initial/return focus and bounded Tab order. */
export function useModalFocus<T extends HTMLElement = HTMLDivElement>({
  open,
  initialFocusRef,
  restoreFocusId,
  onEscape,
  busy = false,
}: {
  open: boolean;
  initialFocusRef: RefObject<HTMLElement | null>;
  restoreFocusId?: string;
  onEscape: () => void;
  busy?: boolean;
}) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<T>(null);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const inerted: Array<{ element: HTMLElement; wasInert: boolean }> = [];
    let branch: HTMLElement | null = overlayRef.current;
    while (branch?.parentElement && branch.parentElement !== document.documentElement) {
      const parent: HTMLElement = branch.parentElement;
      for (const sibling of parent.children) {
        if (sibling === branch || !(sibling instanceof HTMLElement)) continue;
        inerted.push({ element: sibling, wasInert: sibling.inert });
        sibling.inert = true;
      }
      if (parent === document.body) break;
      branch = parent;
    }
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const frame = requestAnimationFrame(() => (initialFocusRef.current ?? dialogRef.current)?.focus());
    return () => {
      cancelAnimationFrame(frame);
      document.body.style.overflow = previousOverflow;
      for (const { element, wasInert } of inerted.reverse()) element.inert = wasInert;
      const returnTo = previous?.isConnected && previous !== document.body ? previous : restoreFocusId ? document.getElementById(restoreFocusId) : null;
      if (returnTo?.isConnected) returnTo.focus();
    };
  }, [open, initialFocusRef, restoreFocusId]);

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      event.preventDefault(); event.stopPropagation();
      if (!busy) onEscape();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])',
    ) ?? []).filter((element) => element.tabIndex >= 0 && !element.closest("[hidden], [inert]") && element.getAttribute("aria-hidden") !== "true")
      .sort((a, b) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
    if (focusable.length === 0) {
      event.preventDefault(); dialogRef.current?.focus(); return;
    }
    const first = focusable[0]; const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !dialogRef.current?.contains(active))) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && (active === last || !dialogRef.current?.contains(active))) {
      event.preventDefault(); first.focus();
    }
  }
  return { overlayRef, dialogRef, onKeyDown };
}
