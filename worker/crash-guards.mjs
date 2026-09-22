// Страховка от каскадного падения (ревью P0): в одном процессе воркера живут все
// BullMQ-очереди, Telegram-polling и reconciliation-таймеры. Любая асинхронная ошибка
// вне try/catch джобы раньше роняла процесс молча и без диагностики.
//
// Политика: fatal = детерминированный отчёт (лог + Sentry) → best-effort дренаж ресурсов
// с жёстким таймаутом → exit(1). Восстановление — за супервизора (systemd Restart=always);
// сам себе процесс выживать не пытается, «продолжить жить в неизвестном состоянии» хуже
// честной смерти.

const DEFAULT_DRAIN_TIMEOUT_MS = 5_000;

export function installCrashGuards({
  logger = console,
  captureException = null,
  onFatal = null,
  exit = (code) => process.exit(code),
  drainTimeoutMs = DEFAULT_DRAIN_TIMEOUT_MS,
} = {}) {
  let triggered = false;

  const handleFatal = async (kind, error) => {
    const normalized = error instanceof Error ? error : new Error(String(error));
    if (triggered) {
      // Повторная фатальная ошибка во время дренажа: выходим сразу, супервизор рестартует.
      logger.error("[worker] повторная фатальная ошибка во время завершения — мгновенный выход", {
        kind,
      });
      exit(1);
      return;
    }
    triggered = true;
    logger.error("[worker] фатальная ошибка процесса", {
      kind,
      errorName: normalized.name,
      // Сообщение и стек идут в лог и Sentry; наружу (в пользовательские каналы) не попадают.
      message: normalized.message,
      stack: typeof normalized.stack === "string" ? normalized.stack.slice(0, 2000) : null,
    });
    try {
      captureException?.(normalized, { captureContext: { tags: { crash_kind: kind } } });
    } catch {
      /* Sentry недоступен — не превращаем отчёт о падении в новое падение */
    }
    try {
      await Promise.race([
        Promise.resolve().then(() => onFatal?.(kind, normalized)),
        new Promise((resolve) => {
          const timer = setTimeout(resolve, drainTimeoutMs);
          timer.unref?.();
        }),
      ]);
    } catch (shutdownError) {
      logger.error("[worker] дренаж после фатальной ошибки не завершился — выходим", {
        message: shutdownError instanceof Error ? shutdownError.message : String(shutdownError),
      });
    }
    exit(1);
  };

  const unhandledRejectionListener = (reason) => {
    void handleFatal("unhandledRejection", reason);
  };
  const uncaughtExceptionListener = (error) => {
    void handleFatal("uncaughtException", error);
  };
  process.on("unhandledRejection", unhandledRejectionListener);
  process.on("uncaughtException", uncaughtExceptionListener);
  // dispose — для тестов и будущих горячих перезапусков без утечки слушателей.
  return Object.assign(handleFatal, {
    dispose: () => {
      process.off("unhandledRejection", unhandledRejectionListener);
      process.off("uncaughtException", uncaughtExceptionListener);
    },
  });
}
