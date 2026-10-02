import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { GuideArticle } from "@/components/guide/guide-article";
import { JsonLd } from "@/components/seo/json-ld";
import { GUIDES, guideBreadcrumb, guideBySlug, guideSlugs } from "@/lib/guides/articles";
import { PRODUCT_NAME } from "@/lib/product";
import { publicOrigin } from "@/lib/seo/public-routes";

export const runtime = "nodejs";

/** Список адресов фиксирован: неизвестный slug отдаёт 404, а не пустую страницу. */
export function generateStaticParams() {
  return guideSlugs().map((slug) => ({ slug }));
}

type Params = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const guide = guideBySlug((await params).slug);
  if (!guide) return { title: { absolute: "Разбор не найден" }, robots: { index: false, follow: false } };
  return {
    title: guide.metaTitle,
    description: guide.description,
    alternates: { canonical: `/guide/${guide.slug}` },
    openGraph: {
      title: guide.metaTitle,
      description: guide.description,
      type: "article",
      url: `/guide/${guide.slug}`,
    },
  };
}

/**
 * Разметка страницы: Article, хлебные крошки и FAQPage — всё из того же объекта,
 * который рендерит текст. Дата модификации берётся из `updatedAt` статьи, а не
 * из текущего времени: иначе каждая загрузка объявляла бы страницу обновлённой.
 */
function articleJsonLd(guide: NonNullable<ReturnType<typeof guideBySlug>>, origin: string) {
  const url = `${origin}/guide/${guide.slug}`;
  return {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: guide.title,
    description: guide.description,
    inLanguage: "ru-RU",
    mainEntityOfPage: url,
    url,
    // Автор — организация, а не выдуманное имя: материал готовит команда продукта.
    // Заменить на Person, когда появится автор-человек с публичным профилем.
    author: { "@type": "Organization", name: PRODUCT_NAME, url: `${origin}/` },
    publisher: { "@id": `${origin}/#organization` },
    isPartOf: { "@id": `${origin}/#website` },
  };
}

function breadcrumbJsonLd(guide: NonNullable<ReturnType<typeof guideBySlug>>, origin: string) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: guideBreadcrumb(guide).map((crumb, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: crumb.name,
      item: new URL(crumb.path, origin).toString(),
    })),
  };
}

function faqJsonLd(guide: NonNullable<ReturnType<typeof guideBySlug>>) {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: guide.faq.map((item) => ({
      "@type": "Question",
      name: item.question,
      acceptedAnswer: { "@type": "Answer", text: item.answer },
    })),
  };
}

export default async function GuidePage({ params }: Params) {
  const guide = guideBySlug((await params).slug);
  if (!guide) notFound();

  const origin = publicOrigin();
  const neighbours = GUIDES.filter((item) => item.slug !== guide.slug);

  return (
    <>
      {origin
        ? [articleJsonLd(guide, origin), breadcrumbJsonLd(guide, origin), faqJsonLd(guide)].map((value) => (
          <JsonLd key={String(value["@type"])} value={value} />
        ))
        : null}

      <GuideArticle guide={guide} />

      <section className="mx-auto w-full max-w-3xl px-5 pb-16 sm:px-8">
        <h2 className="text-[17px] font-bold text-text">Что читать дальше</h2>
        <ul className="mt-3 space-y-2 text-[15px] leading-7">
          {neighbours.map((item) => (
            <li key={item.slug}>
              <Link className="text-brand underline underline-offset-2" href={`/guide/${item.slug}`}>
                {item.title}
              </Link>
            </li>
          ))}
          <li>
            <Link className="text-brand underline underline-offset-2" href="/guide">
              Все разборы о видимости в поиске и в ответах ИИ
            </Link>
          </li>
          <li>
            <Link className="text-brand underline underline-offset-2" href="/#answer">
              Что делает {PRODUCT_NAME} и кому подходит
            </Link>
          </li>
        </ul>
      </section>
    </>
  );
}
