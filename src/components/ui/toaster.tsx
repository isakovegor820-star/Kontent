"use client";

// Уведомления. Тон — ТЗ 7.5: что случилось, что мы уже делаем, нужно ли что-то от тебя.

import { AnimatePresence, motion } from "motion/react";
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

export function Toaster() {
  const { toasts, dismissToast } = useStore();
  // На маршрутах платформы (скоуп .app-v3) тост — бумажный штамп, а не стекло
  const pathname = usePathname();
  const appMode = pathname.startsWith("/app") || pathname.startsWith("/register");

  return (
    <div
      // Тосты не воруют фокус, но объявляются скринридером
      aria-live="polite"
      aria-atomic="false"
      className="pointer-events-none fixed inset-x-0 bottom-0 z-[90] flex flex-col items-center gap-2 p-4 sm:inset-x-auto sm:right-6 sm:bottom-6 sm:items-end sm:p-0"
    >
      <AnimatePresence initial={false}>
        {toasts.map((t) => {
          const Icon = ICONS[t.kind];
          return (
            <motion.div
              key={t.id}
              layout
              initial={{ opacity: 0, y: 16, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.97, transition: { duration: 0.16 } }}
              transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
              className={cn(
                "pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-md p-3.5",
                appMode ? "v3-toast" : "glass-strong",
              )}
            >
              <Icon className={cn("mt-0.5 h-5 w-5 shrink-0", ACCENT[t.kind])} aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="type-body-strong text-text">{t.title}</p>
                {t.body && (
                  <p className="type-secondary mt-0.5 text-text-2 text-pretty">{t.body}</p>
                )}
              </div>
              <button
                onClick={() => dismissToast(t.id)}
                aria-label="Закрыть уведомление"
                className="-m-1 cursor-pointer rounded-md p-1 text-text-3 transition-colors hover:bg-surface-inset hover:text-text"
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
