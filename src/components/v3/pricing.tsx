// Тарифы v3: одна честная жёлтая карточка Free (без карты, лимит виден)
// и тихая Pro-плейсхолдер с пунктирной рамкой: «Позже. Скажем заранее».
// Никаких выдуманных цен — модель монетизации ещё не решена, и мы это говорим прямо.
import Link from "next/link";
import { ArrowRight, Check } from "lucide-react";
import { V3Reveal } from "./reveal";

const FREE_POINTS = [
  "Разведка конкурентов с досье",
  "ИИ-посты твоим голосом — честный дневной лимит",
  "Автопостинг по расписанию, с сервера",
  "Без карты и скрытых платных ограничений",
] as const;

export function V3Pricing() {
  return (
    <section id="pricing" aria-labelledby="v3-pricing-title" className="py-20 sm:py-28">
      <div className="v3-wrap">
        <V3Reveal className="mx-auto max-w-2xl text-center">
          <p className="v3-kicker v3-kicker--center justify-center">Сколько стоит</p>
          <h2
            id="v3-pricing-title"
            className="v3-display mt-6 text-[clamp(1.9rem,4.4vw,3.2rem)] leading-[1.04] font-black uppercase"
          >
            Сейчас — нисколько
          </h2>
          <p className="v3-body mx-auto mt-5 max-w-lg text-[16px]">
            Мы сначала растим живую аудиторию. Если что-то изменится — скажем заранее.
          </p>
        </V3Reveal>

        {/* Full-bleed: карточки во всю ширину листа, без центровочной крышки */}
        <div className="mt-14 grid gap-8 md:grid-cols-2">
          {/* FREE — главная карточка */}
          <V3Reveal>
            <div className="v3-lift relative flex h-full flex-col border-3 border-[var(--ink)] bg-[var(--acc)] p-7 shadow-[8px_8px_0_var(--ink)] sm:p-9">
              <span className="v3-stamp absolute -top-3.5 right-5">Ранний доступ</span>
              <p className="v3-mono text-[11px] font-semibold tracking-[0.14em] uppercase">
                Бесплатно · сейчас
              </p>
              <p className="v3-display mt-3 text-[clamp(2.6rem,5vw,3.6rem)] leading-none font-black">
                0 ₽
              </p>
              {/* На широких экранах пункты встают в две колонки — карточка заполнена */}
              <ul className="mt-6 grid gap-3 xl:grid-cols-2 xl:gap-x-8">
                {FREE_POINTS.map((p) => (
                  <li key={p} className="flex items-start gap-2.5 text-[15px] leading-snug font-semibold">
                    <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center border-2 border-[var(--ink)] bg-[var(--sheet)]">
                      <Check className="h-3 w-3" strokeWidth={3.5} aria-hidden />
                    </span>
                    {p}
                  </li>
                ))}
              </ul>
              <Link href="/register" className="v3-btn v3-btn--ink mt-8 w-full">
                Забрать ранний доступ
                <ArrowRight className="h-4 w-4" strokeWidth={2.5} aria-hidden />
              </Link>
            </div>
          </V3Reveal>

          {/* PRO — честный плейсхолдер */}
          <V3Reveal delay={0.08}>
            <div className="v3-lift relative flex h-full flex-col border-3 border-dashed border-[var(--ink)] bg-[var(--sheet)] p-7 sm:p-9">
              <span className="v3-stamp absolute -top-3.5 right-5">Скажем заранее</span>
              <p className="v3-mono text-[11px] font-semibold tracking-[0.14em] text-[var(--ink-2)] uppercase">
                Расширенный · позже
              </p>
              <p className="v3-display mt-3 text-[clamp(2.6rem,5vw,3.6rem)] leading-none font-black text-[var(--ink-2)]">
                ?
              </p>
              {/* Мерка текста: строка не растягивается в лапшу на широких экранах */}
              <p className="v3-body mt-6 max-w-[52ch] text-[15px]">
                Монетизацию придумаем потом — и расскажем до того, как что-то изменится. Ранним
                пользователям — отдельные условия.
              </p>
              <p className="v3-mono mt-auto pt-6 text-[11px] leading-relaxed tracking-[0.08em] text-[var(--ink-2)] uppercase">
                Без сюрпризов. Обещаем предупредить заранее.
              </p>
            </div>
          </V3Reveal>
        </div>
      </div>
    </section>
  );
}
