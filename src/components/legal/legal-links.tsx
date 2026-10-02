import Link from "next/link";

/**
 * Правовые ссылки в подвале — одним списком.
 *
 * Причина отдельного модуля: подвалов в проекте несколько (лендинг, его
 * сокращённая версия, продуктовый лендинг, юридические страницы), и ссылки
 * на документы расходились между ними: где-то их не было вовсе, а где-то
 * «Политика данных» печаталась текстом без адреса. Требование ч. 2 ст. 18.1
 * 152-ФЗ — доступ к политике обработки с каждой страницы, где собираются
 * данные, поэтому список один и подключается везде.
 *
 * Тексты ссылок: короткие (в подвале) и полные (в юридических документах).
 */
export const LEGAL_LINKS = [
  { href: "/privacy", label: "Политика обработки данных", title: "Политика обработки персональных данных" },
  { href: "/consent", label: "Согласие на обработку", title: "Согласие на обработку персональных данных" },
  { href: "/cookies", label: "Файлы cookie", title: "Использование файлов cookie" },
  { href: "/personal-data", label: "Защита данных", title: "Меры защиты персональных данных" },
  { href: "/terms", label: "Условия использования", title: "Условия использования" },
] as const;

export function LegalLinks({
  className,
  linkClassName,
  ariaLabel = "Правовые документы",
  full = false,
}: {
  /** Класс контейнера: подвалы используют разные системы стилей. */
  className?: string;
  /** Класс каждой ссылки. */
  linkClassName?: string;
  ariaLabel?: string;
  /** Полные названия документов вместо коротких. */
  full?: boolean;
}) {
  return (
    <nav aria-label={ariaLabel} className={className}>
      {LEGAL_LINKS.map((link) => (
        <Link key={link.href} href={link.href} className={linkClassName} title={link.title}>
          {full ? link.title : link.label}
        </Link>
      ))}
    </nav>
  );
}
