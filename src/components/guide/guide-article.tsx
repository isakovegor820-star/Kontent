import Link from "next/link";

import type { Guide } from "@/lib/guides/articles";
import { PRODUCT_DISCLAIMER, PRODUCT_NAME } from "@/lib/product";

/**
 * Единый каркас страницы кластера.
 *
 * Порядок блоков не случаен и повторяет то, что вырезает генеративный движок:
 * ответ в первых 40–60 словах → кому полезно → шаги и таблицы → вопросы
 * заголовками → источники и дата → ссылки на соседние разборы.
 *
 * Вёрстка намеренно лёгкая и на Tailwind-классах: это страницы для поиска и ответов,
 * а не витрина продукта. Никаких клиентских компонентов — весь текст в первом HTML.
 */

/** Время чтения считаем по факту, а не пишем руками: иначе оно врёт после каждой правки. */
function readingMinutes(guide: Guide): number {
  const text = [
    guide.answer,
    guide.audience,
    ...guide.sections.flatMap((section) => [
      section.heading,
      ...(section.body ?? []),
      ...(section.list ?? []),
      ...(section.steps ?? []).flatMap((step) => [step.title, step.text]),
      ...(section.table?.rows ?? []).flat(),
    ]),
    ...guide.faq.flatMap((item) => [item.question, item.answer]),
  ].join(" ");

  const words = text.split(/\s+/u).filter(Boolean).length;
  return Math.max(1, Math.round(words / 180));
}

export function GuideArticle({ guide }: { guide: Guide }) {
  return (
    <main id="main" className="mx-auto w-full max-w-3xl px-5 py-12 text-[16px] leading-relaxed text-text sm:px-8">
      <nav aria-label="Хлебные крошки" className="text-[13px] text-text-3">
        <Link href="/" className="hover:underline">{PRODUCT_NAME}</Link>
        <span aria-hidden="true"> · </span>
        <Link href="/guide" className="hover:underline">Разборы</Link>
      </nav>

      <h1 className="mt-4 text-[clamp(1.75rem,4vw,2.5rem)] font-extrabold leading-tight tracking-[-0.03em]">
        {guide.title}
      </h1>

      <p className="mt-4 text-[13px] text-text-3">
        Обновлено: {guide.updatedAt} · чтение {readingMinutes(guide)} мин
      </p>

      {/* Прямой ответ. Стоит до всего остального — именно его вырезают в ответ. */}
      <p className="mt-6 border-s-[3px] border-brand ps-5 text-[17px] font-medium leading-7">
        {guide.answer}
      </p>

      <p className="mt-6 text-[15px] leading-7 text-text-2">
        <strong className="text-text">Кому полезно. </strong>
        {guide.audience}
      </p>

      {guide.sections.map((section) => (
        <section className="mt-10" key={section.heading}>
          <h2 className="text-[clamp(1.3rem,2.6vw,1.7rem)] font-bold leading-snug tracking-[-0.02em]">
            {section.heading}
          </h2>

          {section.body?.map((paragraph) => (
            <p className="mt-3 text-[15px] leading-7 text-text-2" key={paragraph}>{paragraph}</p>
          ))}

          {section.list ? (
            <ul className="mt-3 list-disc space-y-2 ps-6 text-[15px] leading-7 text-text-2 marker:text-brand">
              {section.list.map((item) => <li key={item}>{item}</li>)}
            </ul>
          ) : null}

          {section.steps ? (
            <ol className="mt-4 space-y-4">
              {section.steps.map((step, index) => (
                <li className="rounded-xl border border-line bg-surface p-4" key={step.title}>
                  <p className="font-semibold text-text">
                    {index + 1}. {step.title}
                  </p>
                  <p className="mt-1.5 text-[15px] leading-7 text-text-2">{step.text}</p>
                </li>
              ))}
            </ol>
          ) : null}

          {section.table ? (
            <div className="mt-4 overflow-x-auto rounded-xl border border-line">
              <table className="w-full min-w-[36rem] border-collapse text-[15px]">
                {section.table.caption ? (
                  <caption className="border-b border-line p-3 text-start text-[13px] text-text-3">
                    {section.table.caption}
                  </caption>
                ) : null}
                <thead>
                  <tr className="bg-surface-inset">
                    {section.table.head.map((cell) => (
                      <th className="border-b border-line p-3 text-start font-semibold text-text" scope="col" key={cell}>
                        {cell}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {section.table.rows.map((row) => (
                    <tr key={row.join("|")}>
                      {row.map((cell, index) => (
                        <td
                          className={`border-b border-line p-3 align-top leading-6 ${index === 0 ? "font-medium text-text" : "text-text-2"}`}
                          // Ячейки фиксированы и не переупорядочиваются, порядок стабилен.
                          key={`${row[0]}-${cell}`}
                        >
                          {cell}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </section>
      ))}

      <section className="mt-12" id="faq">
        <h2 className="text-[clamp(1.3rem,2.6vw,1.7rem)] font-bold leading-snug tracking-[-0.02em]">
          Частые вопросы
        </h2>
        <div className="mt-4 space-y-4">
          {guide.faq.map((item) => (
            <article className="rounded-xl border border-line p-4" key={item.question}>
              <h3 className="text-[17px] font-semibold leading-snug text-text">{item.question}</h3>
              <p className="mt-2 text-[15px] leading-7 text-text-2">{item.answer}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="mt-12 rounded-xl bg-surface p-5">
        <h2 className="text-[15px] font-bold text-text">Источники</h2>
        <ul className="mt-2 space-y-1.5 text-[14px] leading-6 text-text-2">
          {guide.sources.map((source) => (
            <li key={source.url}>
              <a className="text-brand underline underline-offset-2" href={source.url} rel="noreferrer nofollow" target="_blank">
                {source.label}
              </a>
            </li>
          ))}
        </ul>
        <p className="mt-4 text-[13px] leading-6 text-text-3">
          Обновлено: {guide.updatedAt}. {PRODUCT_DISCLAIMER}
        </p>
      </section>
    </main>
  );
}
