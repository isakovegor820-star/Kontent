"use client";

// Границы ошибок в Next 16 — клиентские. Новый проп — unstable_retry (он и перезапрашивает данные).
// Тон сообщения — по ТЗ 7.5: что случилось, что мы уже делаем, нужно ли что-то от тебя.

import { AlertTriangle } from "lucide-react";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";

export default function ErrorBoundary({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => {
    console.error("[interface-error-boundary]", error);
  }, [error]);

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-5 px-6 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-md bg-danger-soft text-danger">
        <AlertTriangle className="h-7 w-7" aria-hidden />
      </div>

      <div>
        <h1 className="text-2xl font-extrabold tracking-tight text-text">Что-то сломалось</h1>
        <p className="mx-auto mt-2 max-w-md text-[15px] leading-relaxed text-text-2">
          Экран не отрисовался. Твои данные на месте — ничего не потерялось. Попробуй открыть
          заново, обычно помогает.
        </p>
        {error.digest && (
          <p className="mt-3 font-mono text-[12px] text-text-3">Код ошибки: {error.digest}</p>
        )}
      </div>

      <Button variant="brand" size="lg" onClick={() => unstable_retry()}>
        Попробовать снова
      </Button>
    </div>
  );
}
