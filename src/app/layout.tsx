import type { Metadata, Viewport } from "next";
import { connection } from "next/server";
import { StoreProvider } from "@/lib/store";
import { Toaster } from "@/components/ui/toaster";
import { jsonLdHtml } from "@/lib/seo/json-ld-html";
import { organizationJsonLd, webSiteJsonLd } from "@/lib/seo/product-json-ld";
import { publicOrigin } from "@/lib/seo/public-routes";
import { OG_IMAGE, baseOpenGraph } from "@/lib/seo/open-graph";
import {
  PRODUCT_DESCRIPTION,
  PRODUCT_NAME,
} from "@/lib/product";
import "./globals.css";

/**
 * Канонический origin. Без metadataBase нельзя задавать canonical и og:image
 * относительным путём — Next падает на сборке, и поля остаются незаполненными.
 * APP_URL — та же переменная, на которой стоит проверка Origin для мутаций,
 * поэтому один источник правды на весь продукт.
 */
const origin = publicOrigin();

export const metadata: Metadata = {
  metadataBase: new URL(origin ?? "http://localhost:3000"),
  title: {
    // Позиционирование задаётся на конкретной странице. В корне — только бренд:
    // иначе служебные маршруты и /app унаследуют обещание, которого на них нет.
    default: PRODUCT_NAME,
    template: `%s · ${PRODUCT_NAME}`,
  },
  description: PRODUCT_DESCRIPTION,
  // noindex стоит точечно на служебных маршрутах; публичные страницы обязаны быть
  // доступны для сниппета целиком. max-image-preview: large нужен, чтобы превью
  // страницы попадало в подборки и в ответы с картинками, а не обрезалось.
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
      "max-video-preview": -1,
    },
  },
  icons: {
    icon: "/icon.svg",
    shortcut: "/icon.svg",
  },
  // Ключевые слова поисковики игнорируют; список оставлен как машиночитаемая памятка
  // о теме сайта и совпадает с позиционированием в lib/product, а не с прежним слоганом.
  keywords: [
    "юридический контент",
    "контент-план для юристов",
    "согласование публикаций",
    "публикация в Telegram",
  ],
  openGraph: {
    ...baseOpenGraph(),
    title: PRODUCT_NAME,
    description: PRODUCT_DESCRIPTION,
  },
  twitter: {
    card: "summary_large_image",
    title: PRODUCT_NAME,
    description: PRODUCT_DESCRIPTION,
    images: [OG_IMAGE.url],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  // Системные панели браузера продолжают фирменный цвет продукта.
  themeColor: "#2563ff",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // A fresh CSP nonce is generated per document request. Waiting for the request here
  // keeps framework scripts and styles nonce-bound instead of serving a static shell
  // whose build-time markup cannot carry that nonce.
  await connection();
  // Аврора как сущность: Organization и WebSite стоят на каждой странице, потому что
  // именно из них генеративный движок собирает «кто это» и «что это». Без APP_URL
  // разметку не отдаём: @id с localhost хуже, чем отсутствие разметки.
  const entityJsonLd = origin
    ? [organizationJsonLd(origin), webSiteJsonLd(origin)]
    : [];
  return (
    <html
      lang="ru"
      className="aurora-system-fonts"
      suppressHydrationWarning
      data-scroll-behavior="smooth"
    >
      <head>
        {entityJsonLd.map((value) => (
          <script
            key={String(value["@type"])}
            type="application/ld+json"
            dangerouslySetInnerHTML={{ __html: jsonLdHtml(value) }}
          />
        ))}
      </head>
      <body className="font-sans">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-[100] focus:rounded-lg focus:bg-[#0a0a0a] focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-white focus:shadow-lg"
        >
          Перейти к содержимому
        </a>
        <StoreProvider>
          {children}
          <Toaster />
        </StoreProvider>
      </body>
    </html>
  );
}
