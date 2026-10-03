import * as Sentry from "@sentry/nextjs";

import { COOKIE_CONSENT_EVENT } from "@/components/legal/cookie-consent-banner";
import { hasAnalyticsConsent, readConsentFromCookieString, type CookieConsent } from "@/lib/cookie-consent";

/**
 * Инициализация клиентской аналитики — только после согласия.
 *
 * Причина отдельного модуля: DSN Sentry зашит в клиентский бандл, и раньше
 * `Sentry.init` вызывался при загрузке любой страницы в production. Это отправка
 * технических данных (включая IP) в Германию до того, как пользователь что-либо
 * выбрал в баннере: обработка без основания и трансграничная передача, которой
 * в политике не было.
 *
 * Теперь порядок такой: пока в cookie нет аналитической категории, `init` не
 * вызывается вовсе — ни одного сетевого запроса. После выбора баннер публикует
 * событие, и клиент поднимается в тот же момент. Обратная сторона: ошибки до
 * согласия в Sentry не попадают — это осознанная плата за отказ от скрытого
 * сбора, а серверный Sentry продолжает работать отдельно.
 */

/** Признак «клиент уже инициализирован»: повторный `init` заменяет клиент Sentry. */
let started = false;

export function resolveTracesSampleRate(input: {
  isProduction: boolean;
  configured?: string | number | null;
}): number {
  const fallback = input.isProduction ? 0.1 : 1;
  // Пустая строка — это «не задано», а не ноль: `Number("")` даёт 0, и ставка
  // трассировки молча становилась бы нулевой вместо значения по умолчанию.
  const raw = typeof input.configured === "string" ? input.configured.trim() : input.configured;
  if (raw === null || raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) return fallback;
  return value;
}

export type SentryEnvironmentInput = {
  isProduction: boolean;
  configuredEnvironment?: string | null;
};

export function resolveSentryEnvironment(input: SentryEnvironmentInput): string {
  return input.configuredEnvironment || (input.isProduction ? "prod" : "development");
}

export function shouldStartClientSentry(input: {
  isProduction: boolean;
  disabled: boolean;
  enableInDevelopment: boolean;
  consent: CookieConsent | null;
}): boolean {
  const allowedEnvironment = input.isProduction || input.enableInDevelopment;
  if (input.disabled || !allowedEnvironment) return false;
  // Единственное основание для клиентской аналитики — согласие пользователя.
  return hasAnalyticsConsent(input.consent);
}

/** Поднимает клиент Sentry, если есть и окружение, и согласие. Идемпотентно. */
export function startClientSentry(documentCookies: string | null = document.cookie): boolean {
  if (started) return true;
  const isProduction = process.env.NODE_ENV === "production";
  const ready = shouldStartClientSentry({
    isProduction,
    disabled: process.env.NEXT_PUBLIC_AURORA_SENTRY_DISABLED === "1",
    enableInDevelopment: process.env.NEXT_PUBLIC_SENTRY_ENABLE_DEV === "true",
    consent: readConsentFromCookieString(documentCookies),
  });
  if (!ready) return false;

  started = true;
  Sentry.init({
    dsn: "https://ed2eb6d188015427081dc1ed0c80b884@o4511981780402176.ingest.de.sentry.io/4511981792329808",
    enabled: true,
    environment: resolveSentryEnvironment({
      isProduction,
      configuredEnvironment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT,
    }),
    tracesSampleRate: resolveTracesSampleRate({
      isProduction,
      configured: process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE,
    }),
    sendDefaultPii: false,
    dataCollection: {
      userInfo: false,
      httpBodies: [],
    },
  });
  return true;
}

/** Реагирует на выбор в баннере: согласие появилось — поднимаем клиент. */
export function watchConsentForSentry(): void {
  window.addEventListener(COOKIE_CONSENT_EVENT, () => {
    startClientSentry();
  });
}
