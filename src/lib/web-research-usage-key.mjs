// Ключ резервации квоты для извлечения фактов из одной страницы.
//
// Контракт резервации узкий, и это не случайно: `acquireWorkerAiUsage` берёт по ключу
// блокировку строки, поэтому ключ обязан быть коротким, устойчивым и предсказуемым.
// `workerAiUsageKey(scope, operationId)` принимает ТОЛЬКО числовой id и на строку
// бросает TypeError, а `workerAiUsageCompositeKey` допускает в каждой части лишь
// `[a-z0-9_-]` длиной до 48 символов. URL страницы не проходит ни то, ни другое.
//
// Ровно на этом и сломался первый боевой прогон: ключ собирался как
// `${runId}:${page.url}`, `Number()` от такой строки даёт NaN, извлечение падало
// с TypeError ещё до обращения к модели — и все двенадцать страниц каждого запуска
// попадали в журнал как `extract_failed` при нуле найденных фактов.
//
// Поэтому URL здесь хешируется: шестнадцатеричный дайджест состоит только из
// допустимых символов, имеет фиксированную длину и остаётся стабильным между
// повторами, то есть повторная обработка той же страницы переиспользует резервацию.

import { createHash } from "node:crypto";

export const WEB_RESEARCH_USAGE_SCOPE = "web-research-extract";

/** Части составного ключа: номер запуска и короткий дайджест адреса страницы. */
export function webResearchUsageKeyParts(runId, url) {
  const id = Number(runId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new TypeError("web research usage: invalid runId");
  }
  const digest = createHash("sha256").update(String(url ?? ""), "utf8").digest("hex").slice(0, 32);
  return [String(id), digest];
}
