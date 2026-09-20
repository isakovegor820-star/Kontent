import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { getPool } from "@/lib/db";
import { listHostedArticles, loadHostedSite, sectionJsonLd } from "@/lib/site-hosted/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ slug: string }> };

const ARTICLE_TYPE_LABEL: Record<string, string> = {
  company_news: "Новости",
  industry_explainer: "Разбор",
  audience_answer: "Ответ на вопрос",
  evergreen_guide: "Гид",
  case_study: "Кейс",
  machine_readable_page: "О компании",
};

function formatDate(value: string | null) {
  if (!value) return null;
  return new Date(value).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const site = await loadHostedSite(getPool(), (await params).slug);
  if (!site) return { title: { absolute: "Раздел не найден" }, robots: { index: false, follow: false } };
  return {
    title: { absolute: `${site.brandName} — материалы и ответы` },
    description: `Полезные материалы, ответы на вопросы и новости ${site.brandName}.`,
    alternates: { canonical: `${site.origin}/` },
    robots: { index: true, follow: true },
    openGraph: { title: `${site.brandName} — материалы`, url: `${site.origin}/`, type: "website", locale: "ru_RU" },
  };
}

export default async function HostedIndexPage({ params }: Params) {
  const pool = getPool();
  const site = await loadHostedSite(pool, (await params).slug);
  if (!site) notFound();
  const articles = await listHostedArticles(pool, site);
  return (
    <main id="main">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(sectionJsonLd(site)) }} />
      <header className="border-b border-line pb-6">
        <p className="text-[13px] font-semibold uppercase tracking-wide text-text-3">Материалы</p>
        <h1 className="mt-2 text-[28px] font-bold leading-tight">{site.brandName}</h1>
        <p className="mt-2 text-text-2">
          Ответы на вопросы, разборы и новости. Основной сайт —{" "}
          <a href={site.canonicalUrl} className="font-semibold text-brand underline-offset-2 hover:underline">{site.confirmedDomain}</a>.
        </p>
      </header>
      {articles.length === 0 ? (
        <p className="mt-8 text-text-2">Материалы готовятся.</p>
      ) : (
        <ul className="mt-8 space-y-8">
          {articles.map((article) => (
            <li key={article.id}>
              <article>
                <p className="text-[13px] text-text-3">
                  {ARTICLE_TYPE_LABEL[article.articleType] || "Материал"}
                  {article.publishedAt ? ` · ${formatDate(article.publishedAt)}` : ""}
                </p>
                <h2 className="mt-1 text-[22px] font-semibold leading-snug">
                  <a href={article.url} className="hover:underline">{article.title}</a>
                </h2>
                {article.metaDescription && <p className="mt-2 text-text-2">{article.metaDescription}</p>}
              </article>
            </li>
          ))}
        </ul>
      )}
      <footer className="mt-12 border-t border-line pt-6 text-[13px] text-text-3">
        <a href={site.canonicalUrl} className="hover:underline">{site.brandName}</a> · раздел ведётся с помощью Авроры
      </footer>
    </main>
  );
}
