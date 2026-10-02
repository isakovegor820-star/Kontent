import type { Metadata } from "next";
import Link from "next/link";

import { GUIDES } from "@/lib/guides/articles";
import { PRODUCT_NAME } from "@/lib/product";

export const metadata: Metadata = {
  title: "Разборы о видимости в поиске и в ответах ИИ",
  description:
    "Как проверить, упоминают ли вас ChatGPT и Алиса, почему сайт не цитируется и что исправлять "
    + "по порядку. Без обещаний роста и без выдуманных цифр.",
  alternates: { canonical: "/guide" },
  openGraph: {
    title: "Разборы о видимости в поиске и в ответах ИИ",
    description:
      "Проверяемые шаги: доступность для краулеров, читаемость без JavaScript, замер ответов, "
      + "внешние упоминания и прямой ответ на странице.",
    url: "/guide",
    type: "website",
  },
};

/**
 * Хаб разборов.
 *
 * Нужен по двум причинам. Первая: страницы кластера должны на что-то ссылаться и откуда-то
 * получать ссылки — иначе они висят в стороне от сайта. Вторая: одна страница-каталог
 * собирает запросы вида «как проверить видимость в ИИ» целиком, не размывая отдельные разборы.
 */
export default function GuideIndexPage() {
  return (
    <main id="main" className="mx-auto w-full max-w-3xl px-5 py-12 text-[16px] leading-relaxed text-text sm:px-8">
      <nav aria-label="Хлебные крошки" className="text-[13px] text-text-3">
        <Link href="/" className="hover:underline">{PRODUCT_NAME}</Link>
        <span aria-hidden="true"> · </span>
        <span>Разборы</span>
      </nav>

      <h1 className="mt-4 text-[clamp(1.75rem,4vw,2.5rem)] font-extrabold leading-tight tracking-[-0.03em]">
        Видимость в поиске и в ответах ИИ
      </h1>

      <p className="mt-5 border-s-[3px] border-brand ps-5 text-[17px] font-medium leading-7">
        Ответы нейросетей строятся поверх обычного поиска: нет в топ-10 — нет и в ответе.
        В этих разборах — проверяемые шаги: пускаете ли вы поисковых агентов, читается ли
        страница без JavaScript, как замерить упоминания и что исправлять по порядку.
      </p>

      <ul className="mt-10 space-y-5">
        {GUIDES.map((guide) => (
          <li className="rounded-xl border border-line p-5" key={guide.slug}>
            <h2 className="text-[19px] font-bold leading-snug">
              <Link className="hover:underline" href={`/guide/${guide.slug}`}>{guide.title}</Link>
            </h2>
            <p className="mt-2 text-[15px] leading-7 text-text-2">{guide.description}</p>
            <p className="mt-2 text-[13px] text-text-3">Обновлено: {guide.updatedAt}</p>
          </li>
        ))}
      </ul>

      <section className="mt-12 rounded-xl bg-surface p-5">
        <h2 className="text-[15px] font-bold text-text">Что умеет {PRODUCT_NAME}</h2>
        <p className="mt-2 text-[15px] leading-7 text-text-2">
          {PRODUCT_NAME} умеет считать видимость сайта в поиске и в ответах ИИ и объяснять
          причины простым языком. Мы не обещаем рост позиций и трафика — показываем, что
          изменилось в измеримых вещах.
        </p>
        <p className="mt-3 text-[15px] leading-7">
          <Link className="text-brand underline underline-offset-2" href="/#answer">
            Что делает {PRODUCT_NAME} и кому подходит
          </Link>
        </p>
      </section>
    </main>
  );
}
