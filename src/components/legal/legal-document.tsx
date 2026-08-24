import Link from "next/link";

import { Logo } from "@/components/brand";

export type LegalSection = {
  title: string;
  paragraphs?: string[];
  items?: string[];
};

export function LegalDocument({
  title,
  description,
  updatedAt,
  sections,
}: {
  title: string;
  description: string;
  updatedAt: string;
  sections: LegalSection[];
}) {
  return (
    <main id="main" className="min-h-dvh bg-bg-section px-5 py-8 text-text sm:py-12">
      <article className="mx-auto w-full max-w-3xl rounded-xl border border-border bg-surface px-5 py-7 shadow-sm sm:px-10 sm:py-10">
        <nav aria-label="Навигация по документу" className="flex flex-wrap items-center justify-between gap-4">
          <Link href="/" className="inline-flex min-h-11 items-center gap-2 rounded-lg font-extrabold no-underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-info">
            <Logo size={32} decorative />
            Аврора
          </Link>
          <Link href="/register" className="inline-flex min-h-11 items-center rounded-lg px-3 text-sm font-semibold text-info underline decoration-1 underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-info">
            Создать аккаунт
          </Link>
        </nav>

        <header className="mt-10 border-b border-border pb-8">
          <p className="text-xs font-bold uppercase tracking-[0.08em] text-info">Документы Авроры</p>
          <h1 className="mt-3 text-3xl font-extrabold leading-tight tracking-[-0.035em] text-balance sm:text-4xl">{title}</h1>
          <p className="mt-4 max-w-2xl text-base leading-7 text-text-2 text-pretty">{description}</p>
          <p className="mt-4 text-sm text-text-3">Редакция от {updatedAt}</p>
        </header>

        <div className="mt-8 space-y-9">
          {sections.map((section, index) => (
            <section key={section.title} aria-labelledby={`legal-section-${index}`}>
              <h2 id={`legal-section-${index}`} className="text-xl font-bold leading-7 tracking-[-0.02em]">
                {index + 1}. {section.title}
              </h2>
              {section.paragraphs?.map((paragraph) => (
                <p key={paragraph} className="mt-3 max-w-[70ch] text-[15px] leading-7 text-text-2 text-pretty">
                  {paragraph}
                </p>
              ))}
              {section.items ? (
                <ul className="mt-3 max-w-[70ch] list-disc space-y-2 ps-6 text-[15px] leading-7 text-text-2 marker:text-info">
                  {section.items.map((item) => <li key={item}>{item}</li>)}
                </ul>
              ) : null}
            </section>
          ))}
        </div>

        <footer className="mt-10 border-t border-border pt-7 text-sm leading-6 text-text-2">
          Вопросы по документам: <a className="font-semibold text-info underline underline-offset-4" href="mailto:legal@avrora.app">legal@avrora.app</a>.
        </footer>
      </article>
    </main>
  );
}
