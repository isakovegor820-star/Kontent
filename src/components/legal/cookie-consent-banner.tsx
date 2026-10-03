"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import Link from "next/link";

import {
  COOKIE_CONSENT_NAME,
  buildConsent,
  consentCookieAttributes,
  readConsentFromCookieString,
  serializeConsent,
  type CookieConsent,
  type CookieConsentDecision,
} from "@/lib/cookie-consent";

/**
 * Событие «выбор сделан». Его слушает инициализация аналитики: пока события нет
 * или в выборе нет аналитической категории, счётчики не запускаются.
 */
export const COOKIE_CONSENT_EVENT = "aurora:cookie-consent";

/** Открыть баннер заново — вызывается из «Настроек cookie» в подвале. */
export const COOKIE_CONSENT_OPEN_EVENT = "aurora:cookie-consent-open";

/** Записывает выбор в cookie и сообщает об этом остальным частям страницы. */
export function persistConsent(consent: CookieConsent) {
  const secure = window.location.protocol === "https:";
  document.cookie = `${COOKIE_CONSENT_NAME}=${serializeConsent(consent)}; ${consentCookieAttributes(secure)}`;
  window.dispatchEvent(new CustomEvent<CookieConsent>(COOKIE_CONSENT_EVENT, { detail: consent }));
}

function subscribeCookieConsent(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === COOKIE_CONSENT_NAME) onChange();
  };
  window.addEventListener(COOKIE_CONSENT_EVENT, onChange);
  window.addEventListener(COOKIE_CONSENT_OPEN_EVENT, onChange);
  window.addEventListener("storage", onStorage);
  // Первое уведомление сразу после подписки: на сервере снимок был null
  // (cookie недоступна), на клиенте он уже настоящий. Без этого React считает,
  // что данные не менялись, и баннер не появляется до первого внешнего события.
  onChange();
  return () => {
    window.removeEventListener(COOKIE_CONSENT_EVENT, onChange);
    window.removeEventListener(COOKIE_CONSENT_OPEN_EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

/** Есть ли решение и какое: стабильная строка вместо сырой cookie. */
function consentSnapshot(): string | null {
  const consent = readConsentFromCookieString(document.cookie);
  if (!consent) return null;
  // Набор категорий и версия — всё, что влияет на показ баннера. Время выбора
  // в снимок не входит: иначе React видел бы новое значение на каждой проверке.
  return `${consent.decision}:${consent.version}:${consent.categories.analytics ? 1 : 0}${
    consent.categories.marketing ? 1 : 0
  }`;
}

function serverSnapshot(): string | null {
  return null;
}

export function CookieConsentBanner() {
  // Подписка на cookie вместо чтения в эффекте: React сам перечитывает снимок
  // после подписки и при каждом событии (свой выбор, смена в другой вкладке).
  // На сервере снимок — null, поэтому гидратация совпадает с первым рендером.
  const consentKey = useSyncExternalStore(subscribeCookieConsent, consentSnapshot, serverSnapshot);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Возврат к выбору по ссылке «Настройки cookie»: setState живёт в обработчике
  // события, а не в теле эффекта — это штатный способ реагировать на действие
  // пользователя, а не на изменение пропсов.
  useEffect(() => {
    const reopen = () => setSettingsOpen(true);
    window.addEventListener(COOKIE_CONSENT_OPEN_EVENT, reopen);
    return () => window.removeEventListener(COOKIE_CONSENT_OPEN_EVENT, reopen);
  }, []);
  // null — решения ещё нет: спрашиваем. Иначе баннер открывается только вручную.
  const visible = consentKey === null || settingsOpen;

  const decide = useCallback((next: CookieConsentDecision) => {
    persistConsent(buildConsent(next));
    setSettingsOpen(false);
  }, []);

  if (!visible) return null;

  return (
    <section
      role="region"
      aria-label="Использование файлов cookie"
      className="fixed inset-x-0 bottom-0 z-50 border-t border-border bg-surface/95 px-4 py-4 shadow-[0_-8px_24px_rgba(0,0,0,0.08)] backdrop-blur sm:px-6"
    >
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-3 text-sm leading-6 text-text-2">
        <p className="max-w-[80ch] text-pretty">
          Мы используем файлы cookie. Необходимые обеспечивают вход и работу платформы; аналитические и
          рекламные помогают понимать, как ей пользуются, и подключаются только с вашего согласия.
          Подробнее — в{" "}
          <Link className="font-semibold text-info underline underline-offset-4" href="/cookies">
            описании cookie
          </Link>{" "}
          и{" "}
          <Link className="font-semibold text-info underline underline-offset-4" href="/privacy">
            политике обработки данных
          </Link>
          .
        </p>

        {settingsOpen ? (
          <ul className="flex flex-wrap gap-x-6 gap-y-2">
            <li className="text-text">Необходимые — всегда включены</li>
            <li>
              <label className="inline-flex min-h-11 cursor-pointer items-center gap-2">
                <input type="checkbox" defaultChecked={false} data-cookie-category="analytics" />
                Аналитические
              </label>
            </li>
            <li>
              <label className="inline-flex min-h-11 cursor-pointer items-center gap-2">
                <input type="checkbox" defaultChecked={false} data-cookie-category="marketing" />
                Рекламные
              </label>
            </li>
          </ul>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => decide("all")}
            className="min-h-11 rounded-lg bg-info px-4 text-sm font-semibold text-white transition-opacity hover:opacity-90"
          >
            Принять все
          </button>
          <button
            type="button"
            onClick={() => decide("necessary")}
            className="min-h-11 rounded-lg border border-border px-4 text-sm font-semibold text-text transition-colors hover:bg-bg-section"
          >
            Только необходимые
          </button>
          <button
            type="button"
            onClick={() => {
              if (!settingsOpen) {
                setSettingsOpen(true);
                return;
              }
              const analytics = Boolean(
                document.querySelector<HTMLInputElement>('input[data-cookie-category="analytics"]')?.checked,
              );
              const marketing = Boolean(
                document.querySelector<HTMLInputElement>('input[data-cookie-category="marketing"]')?.checked,
              );
              persistConsent(buildConsent("custom", { categories: { analytics, marketing } }));
              setSettingsOpen(false);
            }}
            className="min-h-11 rounded-lg px-4 text-sm font-semibold text-info underline underline-offset-4"
          >
            {settingsOpen ? "Сохранить выбор" : "Настроить"}
          </button>
        </div>
      </div>
    </section>
  );
}
