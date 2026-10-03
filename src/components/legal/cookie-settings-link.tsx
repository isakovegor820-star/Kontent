"use client";

import { COOKIE_CONSENT_OPEN_EVENT } from "@/components/legal/cookie-consent-banner";

/**
 * «Настройки cookie» для подвалов.
 *
 * Отдельный клиентский компонент: подвалы серверные, а выбор по cookie хранится
 * в браузере, поэтому вернуть пользователя к выбору можно только событием на
 * клиенте. Оформлено кнопкой-ссылкой: подвал продуктового лендинга запрещает
 * кнопки тестом (`production-footer.test.ts`), поэтому там этот элемент не
 * подключается — вместо него правовые ссылки ведут на страницу `/cookies`,
 * где описано, как изменить выбор.
 */
export function CookieSettingsLink({ className }: { className?: string }) {
  return (
    <button
      type="button"
      className={className ?? "text-left underline decoration-1 underline-offset-4"}
      onClick={() => window.dispatchEvent(new Event(COOKIE_CONSENT_OPEN_EVENT))}
    >
      Настройки cookie
    </button>
  );
}
