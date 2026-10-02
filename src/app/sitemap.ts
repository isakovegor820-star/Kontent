import type { MetadataRoute } from "next";

import { GUIDES } from "@/lib/guides/articles";
import { PUBLIC_ROUTES, publicOrigin } from "@/lib/seo/public-routes";

/**
 * Рендер на каждый запрос. Без этого Next кэширует маршрут и генерирует его на этапе
 * сборки, где переменной APP_URL ещё нет: карта сайта уходила в прод пустой
 * (`x-nextjs-cache: HIT`), а в robots.txt не появлялась строка Sitemap.
 * Цена — один дешёвый рендер на запрос; выгода — адреса всегда совпадают с origin прода.
 */
export const dynamic = "force-dynamic";

/**
 * /sitemap.xml домена продукта. До этого файла карты сайта не было вообще: поиск
 * узнавал о страницах только по внешним ссылкам.
 *
 * Хостируемые разделы клиентов сюда не попадают: они живут на <slug>.<домен> и отдают
 * собственную карту (/hosted/<slug>/sitemap.xml), поэтому смешивать два хоста в одном
 * файле нельзя — loc обязан быть на том же хосте, что и сам sitemap.
 *
 * Если APP_URL не задан, возвращаем пустой список вместо карты с чужими адресами:
 * пустая карта безопасна, карта с localhost в проде — нет.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const origin = publicOrigin();
  if (!origin) return [];
  return [
    ...PUBLIC_ROUTES.map((route) => ({
      url: new URL(route.path, origin).toString(),
      changeFrequency: route.changeFrequency,
      priority: route.priority,
    })),
    // Разборы перечисляются из данных, а не руками: новая статья попадает в карту
    // тем же коммитом, что и сама страница, и не может «забыться».
    ...GUIDES.map((guide) => ({
      url: new URL(`/guide/${guide.slug}`, origin).toString(),
      changeFrequency: "monthly" as const,
      priority: 0.6,
    })),
  ];
}
