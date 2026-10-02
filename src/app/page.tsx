import type { Metadata } from "next";
import { ReferenceLanding } from "@/components/landing/reference-landing";
import { jsonLdHtml } from "@/lib/seo/json-ld-html";
import { softwareApplicationJsonLd } from "@/lib/seo/product-json-ld";
import { publicOrigin } from "@/lib/seo/public-routes";
import { baseOpenGraph } from "@/lib/seo/open-graph";
import { PRODUCT_DESCRIPTION, PRODUCT_TITLE } from "@/lib/product";

const TITLE = PRODUCT_TITLE;
const DESCRIPTION = PRODUCT_DESCRIPTION;

export const metadata: Metadata = {
  title: { absolute: TITLE },
  description: DESCRIPTION,
  // Канонический адрес задаётся точечно на публичных страницах, а не в корневом layout:
  // значение из layout унаследовали бы /app/* и служебные маршруты, и каждый из них
  // объявил бы себя копией главной.
  alternates: { canonical: "/" },
  openGraph: { ...baseOpenGraph(), url: "/", title: TITLE, description: DESCRIPTION },
};

export default function LandingPage() {
  // Origin читается в рендере, а не на уровне модуля: иначе значение замерзает при
  // импорте, не проверяется тестом и не реагирует на смену окружения.
  const origin = publicOrigin();
  return (
    <>
      {origin && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: jsonLdHtml(softwareApplicationJsonLd(origin)) }}
        />
      )}
      <ReferenceLanding />
    </>
  );
}
