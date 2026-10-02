/**
 * Структурированные данные собственного домена Авроры.
 *
 * Раньше JSON-LD был только на хостируемых страницах клиентов: продукт умел размечать
 * чужие сайты и не размечал свой. Для генеративных ответов это критично — Organization и
 * SoftwareApplication дают движку факты, из которых собирается описание сущности, вместо
 * догадок по тексту страницы.
 *
 * Здесь нет ни одного выдуманного поля. Сознательно отсутствуют:
 *   • legalName, address, vatID, foundingDate — юридические реквизиты не подтверждены;
 *   • sameAs — реальные профили не подтверждены, а неверная ссылка хуже отсутствующей;
 *   • offers / price — тарифы не опубликованы;
 *   • aggregateRating — отзывов с проверяемым источником нет.
 * Пустое поле схема допускает; выдуманное — нет. Как только факт появится, он
 * добавляется одной строкой в массив ниже.
 *
 * Имя, описание и список возможностей приходят из `lib/product` — того же модуля,
 * из которого их берут title, манифест и лендинг. Разметка не может рассказывать
 * о продукте не то же самое, что страница: это одна и та же строка в памяти.
 */

import {
  PRODUCT_ALTERNATE_NAMES,
  PRODUCT_FEATURES,
  PRODUCT_NAME,
  PRODUCT_SUMMARY,
} from "@/lib/product";

/** Заполнить реальными профилями (vc.ru, Habr, Telegram-канал, VK, GitHub и т. п.). */
const BRAND_SAME_AS: readonly string[] = Object.freeze([]);

export function organizationJsonLd(origin: string): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    "@id": `${origin}/#organization`,
    name: PRODUCT_NAME,
    alternateName: [...PRODUCT_ALTERNATE_NAMES],
    url: `${origin}/`,
    logo: `${origin}/icon.svg`,
    description: PRODUCT_SUMMARY,
    ...(BRAND_SAME_AS.length > 0 ? { sameAs: [...BRAND_SAME_AS] } : {}),
  };
}

export function webSiteJsonLd(origin: string): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    "@id": `${origin}/#website`,
    name: PRODUCT_NAME,
    alternateName: [...PRODUCT_ALTERNATE_NAMES],
    url: `${origin}/`,
    inLanguage: "ru-RU",
    publisher: { "@id": `${origin}/#organization` },
  };
}

export function softwareApplicationJsonLd(origin: string): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    "@id": `${origin}/#software`,
    name: PRODUCT_NAME,
    alternateName: [...PRODUCT_ALTERNATE_NAMES],
    applicationCategory: "BusinessApplication",
    applicationSubCategory: "SMM и управление контентом",
    operatingSystem: "Web",
    url: `${origin}/`,
    inLanguage: "ru-RU",
    description: PRODUCT_SUMMARY,
    featureList: [...PRODUCT_FEATURES],
    publisher: { "@id": `${origin}/#organization` },
  };
}

/**
 * Сериализация и экранирование «<» живут в lib/seo/json-ld-html: там закрыт вектор
 * выламывания из script-блока (ревью P2). Здесь только сборка объектов схемы.
 */
