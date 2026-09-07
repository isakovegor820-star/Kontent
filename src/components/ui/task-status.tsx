"use client";

import { cn } from "@/lib/utils";
import styles from "./task-status.module.css";

/** A quiet, shared progress line for tasks whose result is still arriving. */
export function TaskStatus({
  label = "Думаю…",
  onStop,
  announce = true,
  className,
}: {
  label?: string;
  onStop?: () => void;
  /** Disable when the parent already has a stable live region. */
  announce?: boolean;
  className?: string;
}) {
  return (
    <div className={cn(styles.status, className)}>
      <span
        className={styles.label}
        role={announce ? "status" : undefined}
        aria-atomic={announce ? true : undefined}
      >
        {label}
      </span>
      {onStop && (
        <button
          type="button"
          className={styles.stop}
          onClick={onStop}
          aria-label="Остановить генерацию"
          title="Остановить генерацию"
        >
          <span className={styles.stopIcon} aria-hidden />
        </button>
      )}
    </div>
  );
}
