/**
 * Общие поля Open Graph.
 *
 * Причина отдельного модуля: вложенные поля метаданных (openGraph, twitter, robots)
 * не сливаются между сегментами — последний сегмент, задавший openGraph, перетирает
 * родительский целиком. Пока базовые поля лежали только в корневом layout, любой
 * `openGraph: { url, title }` на странице молча уносил с собой og:image и site_name.
 * Поэтому база одна и раскладывается явно там, где страница задаёт свои поля.
 */
export const OG_IMAGE = {
  url: "/brand/og-aurora.png",
  width: 1200,
  height: 630,
  alt: "Аврора — контент с проверкой рисков и доказательств",
};

export type BaseOpenGraph = {
  siteName: string;
  locale: string;
  type: "website";
  images: (typeof OG_IMAGE)[];
};

export function baseOpenGraph(): BaseOpenGraph {
  return {
    siteName: "Аврора",
    locale: "ru_RU",
    type: "website",
    images: [OG_IMAGE],
  };
}
