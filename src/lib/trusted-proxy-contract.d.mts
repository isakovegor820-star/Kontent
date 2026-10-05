export type TrustedProxyEnv = Record<string, string | undefined>;

/** Стабильный код ошибки boot-контракта: `trusted_proxy_hops_not_configured`. */
export const TRUSTED_PROXY_HOPS_ERROR: string;

/**
 * Число доверенных proxy-хоп; невалидное или незаданное значение даёт 1, поэтому
 * рантайм не ломается — а в production явность требует assertTrustedProxyBootContract.
 */
export function resolveTrustedProxyHops(env?: TrustedProxyEnv): number;

/**
 * Fail-closed контракт запуска: в `NODE_ENV=production` (вне сборки и тестов) требует
 * целое 1..10 в `AURORA_TRUSTED_PROXY_HOPS`, иначе бросает `trusted_proxy_hops_not_configured`.
 */
export function assertTrustedProxyBootContract(env?: TrustedProxyEnv): void;
