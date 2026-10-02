import { headers } from "next/headers";

/**
 * Nonce текущего запроса.
 *
 * `proxy.ts` генерирует его на каждый документ и кладёт в заголовок `x-nonce` вместе
 * с CSP. Свои скрипты Next помечает nonce сам, но любой `<script>`, отрендеренный
 * вручную, обязан нести его тоже — этого требует проверка релиза
 * (`scripts/deployment-smoke.mjs`, `deployment_smoke_nonce_binding_failed`):
 * каждый элемент script и style в документе должен совпадать с nonce из CSP.
 *
 * Возвращает `undefined`, если заголовка нет: так бывает только вне proxy, например
 * в модульных тестах. Атрибут в этом случае не рендерится — придумывать nonce нельзя,
 * он должен приходить от сервера.
 */
export async function requestNonce(): Promise<string | undefined> {
  const store = await headers();
  return store.get("x-nonce") ?? undefined;
}
