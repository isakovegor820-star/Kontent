"use client";

// Сегментная граница ошибки для рабочих экранов: падение одного раздела не
// выкидывает пользователя в общий «Что-то сломалось» без контекста. Тон — ТЗ 7.5.

import { AlertTriangle } from "lucide-react";
import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";

export function RouteErrorBoundary({
  error,
  unstable_retry,
  title,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
  title: string;
}) {
  useEffect(() => {
    Sentry.captureException(error);
    console.error("[route-error-boundary]", title, error);
  }, [error, title]);

  return (
    <div className="mx-auto flex w-full max-w-lg flex-col items-center gap-5 px-6 py-16 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-md bg-danger-soft text-danger">
        <AlertTriangle className="h-6 w-6" aria-hidden />
      </div>
      <div>
        <h1 className="text-xl font-extrabold tracking-tight text-text">
          Не удалось открыть «{title}»
        </h1>
        <p className="mx-auto mt-2 max-w-md text-[14px] leading-relaxed text-text-2">
          Экран не отрисовался, но данные на месте. Попробуй ещё раз — обычно помогает.
        </p>
        {error.digest && (
          <p className="mt-3 font-mono text-[12px] text-text-3">Код ошибки: {error.digest}</p>
        )}
      </div>
      <Button variant="brand" onClick={() => unstable_retry()}>
        Попробовать снова
      </Button>
    </div>
  );
}
