"use client";

// Уведомления. Тон — ТЗ 7.5: что случилось, что мы уже делаем, нужно ли что-то от тебя.

import { useCallback, useEffect, useRef } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { usePathname } from "next/navigation";
import { AlertTriangle, CheckCircle2, Flame, Info, X } from "lucide-react";

import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";

const ICONS = {
  success: CheckCircle2,
  danger: AlertTriangle,
  fire: Flame,
  info: Info,
};

const ACCENT = {
  success: "text-success",
  danger: "text-danger",
  fire: "text-fire",
  info: "text-brand",
};

const AUTO_DISMISS_MS = 7_000;
type Toast = ReturnType<typeof useStore>["toasts"][number];

function ToastItem({
  toast,
  appMode,
  reducedMotion,
  onDismiss,
}: {
  toast: Toast;
  appMode: boolean;
  reducedMotion: boolean;
  onDismiss: (id: string) => void;
}) {
  const Icon = ICONS[toast.kind];
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startedAtRef = useRef(0);
  const remainingRef = useRef(AUTO_DISMISS_MS);

  const clearTimer = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const resumeTimer = useCallback(() => {
    // Critical failures remain until the user explicitly dismisses them.
    if (toast.kind === "danger" || timerRef.current || remainingRef.current <= 0) return;
    startedAtRef.current = Date.now();
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      onDismiss(toast.id);
    }, remainingRef.current);
  }, [onDismiss, toast.id, toast.kind]);

  const pauseTimer = useCallback(() => {
    if (!timerRef.current) return;
    remainingRef.current = Math.max(0, remainingRef.current - (Date.now() - startedAtRef.current));
    clearTimer();
  }, [clearTimer]);

  useEffect(() => {
    remainingRef.current = AUTO_DISMISS_MS;
    resumeTimer();
    return clearTimer;
  }, [clearTimer, resumeTimer]);

  return (
    <motion.div
      layout={!reducedMotion}
      initial={reducedMotion ? false : { opacity: 0, y: 16, scale: 0.96 }}
      animate={reducedMotion ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }}
      exit={reducedMotion
        ? { opacity: 0, transition: { duration: 0 } }
        : { opacity: 0, y: 8, scale: 0.97, transition: { duration: 0.16 } }}
      transition={reducedMotion ? { duration: 0 } : { duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
      role={toast.kind === "danger" ? "alert" : "status"}
      aria-live={toast.kind === "danger" ? "assertive" : "polite"}
      aria-atomic="true"
      onMouseEnter={pauseTimer}
      onMouseLeave={resumeTimer}
      onFocusCapture={pauseTimer}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) resumeTimer();
      }}
      className={cn(
        "pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-md p-3.5",
        appMode ? "v3-toast" : "glass-strong",
      )}
    >
      <Icon className={cn("mt-0.5 h-5 w-5 shrink-0", ACCENT[toast.kind])} aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="type-body-strong text-text">{toast.title}</p>
        {toast.body && (
          <p className="type-secondary mt-0.5 text-pretty text-text-2">{toast.body}</p>
        )}
      </div>
      <button
        type="button"
        onClick={() => onDismiss(toast.id)}
        aria-label="Закрыть уведомление"
        className="-m-2 inline-flex min-h-11 min-w-11 cursor-pointer items-center justify-center rounded-md text-text-3 transition-colors hover:bg-surface-inset hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand motion-reduce:transition-none"
      >
        <X className="h-4 w-4" aria-hidden />
      </button>
    </motion.div>
  );
}

export function Toaster() {
  const { toasts, dismissToast } = useStore();
  const reducedMotion = useReducedMotion() ?? false;
  // На маршрутах платформы тост продолжает её тёмную слоистую поверхность.
  const pathname = usePathname();
  const appMode = pathname.startsWith("/app") || pathname.startsWith("/admin");

  return (
    <div
      aria-label="Уведомления"
      className={cn(
        "pointer-events-none fixed inset-x-0 z-[90] flex flex-col items-center gap-2 p-4 sm:inset-x-auto sm:right-6 sm:items-end sm:p-0",
        appMode
          ? "top-[calc(env(safe-area-inset-top)+14.5rem)] bottom-auto sm:top-28 lg:top-24"
          : "bottom-[env(safe-area-inset-bottom)] sm:bottom-6",
      )}
    >
      <AnimatePresence initial={false}>
        {toasts.map((toast) => (
          <ToastItem
            key={toast.id}
            toast={toast}
            appMode={appMode}
            reducedMotion={reducedMotion}
            onDismiss={dismissToast}
          />
        ))}
      </AnimatePresence>
    </div>
  );
}
