import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { getPool } from "@/lib/db";
import { articleJsonLd, loadHostedArticle, loadHostedSite } from "@/lib/site-hosted/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ slug: string; article: string }> };

function formatDate(value: string | null) {
  if (!value) return null;
  return new Date(value).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug, article: articleSlug } = await params;
  const pool = getPool();
  const site = await loadHostedSite(pool, slug);
  const article = site ? await loadHostedArticle(pool, site, articleSlug) : null;
  if (!site || !article) return { title: { absolute: "Материал не найден" }, robots: { index: false, follow: false } };
  return {
    title: { absolute: `${article.title} — ${site.brandName}` },
    description: article.metaDescription || undefined,
    alternates: { canonical: article.url },
    robots: { index: true, follow: true },
    openGraph: {
      title: article.title,
      description: article.metaDescription || undefined,
      url: article.url,
      type: "article",
      locale: "ru_RU",
      publishedTime: article.publishedAt || undefined,
      modifiedTime: article.updatedAt || undefined,
    },
  };
}

export default async function HostedArticlePage({ params }: Params) {
  const { slug, article: articleSlug } = await params;
  const pool = getPool();
  const site = await loadHostedSite(pool, slug);
  if (!site) notFound();
  const article = await loadHostedArticle(pool, site, articleSlug);
  if (!article) notFound();
  return (
    <main id="main">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(articleJsonLd(site, article)) }} />
      <nav className="text-[13px] text-text-3" aria-label="Навигация">
        <a href={`${site.origin}/`} className="hover:underline">{site.brandName} — материалы</a>
      </nav>
      <article className="mt-4">
        <header>
          <h1 className="text-[30px] font-bold leading-tight">{article.title}</h1>
          {article.publishedAt && (
            <p className="mt-2 text-[13px] text-text-3">
              <time dateTime={article.publishedAt}>{formatDate(article.publishedAt)}</time>
              {article.updatedAt && article.updatedAt.slice(0, 10) !== article.publishedAt.slice(0, 10) ? ` · обновлено ${formatDate(article.updatedAt)}` : ""}
            </p>
          )}
          {article.metaDescription && <p className="mt-4 text-[18px] text-text-2">{article.metaDescription}</p>}
        </header>
        {/* body_html собран нашим рендерером Markdown с экранированием любого HTML из модели. */}
        <div className="hosted-article mt-6 space-y-4 [&_h2]:mt-8 [&_h2]:text-[22px] [&_h2]:font-semibold [&_h3]:mt-6 [&_h3]:text-[18px] [&_h3]:font-semibold [&_a]:text-brand [&_a]:underline-offset-2 hover:[&_a]:underline [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:list-decimal [&_ol]:pl-6 [&_blockquote]:border-l-4 [&_blockquote]:border-line [&_blockquote]:pl-4 [&_blockquote]:text-text-2" dangerouslySetInnerHTML={{ __html: article.bodyHtml }} />
      </article>
      <footer className="mt-12 border-t border-line pt-6 text-[13px] text-text-3">
        Материал подготовлен для <a href={site.canonicalUrl} className="hover:underline">{site.brandName}</a>.
      </footer>
    </main>
  );
}
