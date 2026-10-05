/**
 * Boot-контракт доверенного ingress.
 *
 * Живёт в .mjs по конвенции проекта: одна и та же логика нужна и рантайму приложения
 * (TypeScript видит её через `trusted-proxy-contract.d.mts`), и префлайту точек входа
 * на чистом Node (`scripts/start.mjs`, `scripts/start-web.mjs`).
 *
 * Почему не две копии: инцидент 2026-10-05. Контракт существовал в рантайме, но
 * локальный launchd-сервис запускал `next start` мимо префлайта и без переменной —
 * процесс сутки отвечал 500 на каждый запрос, оставаясь «живым».
 */

/** Код ошибки. Стабилен: на него ссылаются тесты и журналы эксплуатации. */
export const TRUSTED_PROXY_HOPS_ERROR = "trusted_proxy_hops_not_configured";

/**
 * Число доверенных proxy-хоп между клиентом и процессом. Неверное значение —
 * не косметика: 0/miss при прямом доступе к Next означает подставляемый клиентом
 * X-Forwarded-For (обход IP-лимитов) или общий bucket "unknown" (self-DoS).
 * Невалидное/незаданное значение даёт 1 — рантайм остаётся работоспособным,
 * но в production это проверяется на boot: см. assertTrustedProxyBootContract.
 */
export function resolveTrustedProxyHops(env = process.env) {
  const configured = Number(String(env.AURORA_TRUSTED_PROXY_HOPS || "").trim() || Number.NaN);
  return Number.isSafeInteger(configured) && configured >= 1 && configured <= 10 ? configured : 1;
}

/** Fail-closed контракт запуска web-процесса (ревью P1): в production хопы обязаны быть заданы явно. */
export function assertTrustedProxyBootContract(env = process.env) {
  if (env.NODE_ENV !== "production") return;
  // Сборка и тесты не обслуживают трафик — контракт проверяется только на живом рантайме.
  if (env.NEXT_PHASE === "phase-production-build" || env.VITEST) return;
  const raw = String(env.AURORA_TRUSTED_PROXY_HOPS || "").trim();
  const configured = Number(raw);
  if (!raw || !Number.isSafeInteger(configured) || configured < 1 || configured > 10) {
    throw new Error(TRUSTED_PROXY_HOPS_ERROR);
  }
}
