import { jsonLdHtml } from "@/lib/seo/json-ld-html";
import { requestNonce } from "@/lib/seo/request-nonce";

/**
 * Единственный способ отрендерить JSON-LD в этом приложении.
 *
 * Причина, по которой это отдельный компонент, а не `dangerouslySetInnerHTML` по месту:
 * проверка релиза требует, чтобы **каждый** элемент `<script>` в документе нёс nonce
 * из CSP. Скрипты Next размечает сам, а JSON-LD, отрендеренный вручную, оставался без
 * nonce — и релиз откатывался на проверке `deployment_smoke_nonce_binding_failed`.
 * Один компонент на все страницы означает, что забыть nonce больше нельзя.
 *
 * Тест `json-ld.test.tsx` дополнительно сканирует исходники: если кто-то снова напишет
 * `<script type="application/ld+json">` напрямую, сборка тестов упадёт.
 */
export async function JsonLd({ value }: { value: Record<string, unknown> }) {
  const nonce = await requestNonce();
  return (
    <script
      type="application/ld+json"
      nonce={nonce}
      dangerouslySetInnerHTML={{ __html: jsonLdHtml(value) }}
    />
  );
}
