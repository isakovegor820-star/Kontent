/**
 * Сериализация JSON-LD для <script type="application/ld+json"> (ревью P2).
 *
 * JSON.stringify не экранирует «<»: значение вида "</script><script…" из
 * user-контролируемых полей (brandName, structuredData статьи) выламывалось из
 * script-блока — stored HTML-injection на hosted-поддомене. Экранирование «<»
 * сохраняет валидность JSON (\u003c — тот же символ) и убивает вектор целиком.
 *
 * Модуль вынесен отдельно от site-hosted/service, чтобы публичные страницы продукта
 * (layout, лендинг) не тянули в свой бандл pg и token-crypto: они используют ровно одну
 * функцию, и на ней не должно висеть подключение к базе.
 */
export function jsonLdHtml(value: Record<string, unknown>): string {
  return JSON.stringify(value).replace(/</gu, "\\u003c");
}
