import * as Sentry from "@sentry/nextjs";

import { startClientSentry, watchConsentForSentry } from "@/lib/sentry-client";

/**
 * Клиентская инициализация Sentry.
 *
 * Пока в cookie нет аналитического согласия, `init` не вызывается: счётчики и
 * трассировка не должны стартовать до выбора пользователя в баннере. Модуль
 * читает cookie синхронно — асинхронный порядок в client instrumentation не
 * гарантирован, а решение нужно до первого сетевого запроса SDK.
 *
 * Серверный Sentry (`sentry.server.config.ts`) живёт отдельно и на клиентское
 * согласие не опирается.
 */
startClientSentry();
watchConsentForSentry();

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
