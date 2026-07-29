// Боли → решения: реестр БЫЛО/СТАЛО. Никаких флипов — боль читается столько,
// сколько нужно, и зачёркнута красным штампом. Решение — зелёная ячейка рядом.
import { ArrowRight } from "lucide-react";
import { V3Reveal } from "./reveal";

const ROWS = [
  {
    pain: "Нет времени постить",
    painNote: "Открываешь редактор — и закрываешь. Каждый день.",
    feature: "Автопилот",
    solutionTitle: "Неделя за 15 минут",
    solution:
      "Автопилот собирает план на неделю. Ты жмёшь одну кнопку — 7 постов уходят сами.",
  },
  {
    pain: "Не знаю, что снимать",
    painNote: "Идей нет, а лента ждёт.",
    feature: "Тренды",
    solutionTitle: "Идеи приходят сами",
    solution:
      "Лента «Сними это»: готовые карточки-идеи со сценарием и хуком. Один клик — черновик.",
  },
  {
    pain: "Конкуренты растут — непонятно почему",
    painNote: "Видишь цифры, но не видишь причину.",
    feature: "Разведка",
    solutionTitle: "Видно, что у них работает",
    solution:
      "Полное досье на каждого: какие темы и форматы дают результат — человеческим языком.",
  },
] as const;

export function V3Ledger() {
  return (
    <section aria-labelledby="v3-ledger-title" className="py-20 sm:py-28">
      <div className="v3-wrap">
        <V3Reveal className="mx-auto max-w-2xl text-center">
          <p className="v3-kicker v3-kicker--center justify-center">Знакомо?</p>
          <h2
            id="v3-ledger-title"
            className="v3-display mt-6 text-[clamp(1.9rem,4.4vw,3.2rem)] leading-[1.04] font-black uppercase"
          >
            Три причины, по которым каналы стоят
          </h2>
          <p className="v3-body mx-auto mt-5 max-w-lg text-[16px]">
            Каждую платформа закрывает не советом, а работой, которую берёт на себя.
          </p>
        </V3Reveal>

        <ul className="mt-14 space-y-6">
          {ROWS.map((row, i) => (
            <V3Reveal key={row.pain} delay={i * 0.06}>
              <li className="grid items-stretch gap-4 lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] lg:gap-6">
                {/* БЫЛО — красная ячейка, текст вычеркнут */}
                <div className="v3-lift relative border-2 border-[var(--ink)] bg-[var(--red-soft)] p-6 shadow-[5px_5px_0_var(--ink)]">
                  <span className="v3-stamp v3-stamp--red absolute -top-3.5 left-5">
                    Было
                  </span>
                  <p className="mt-2 text-[18px] leading-snug font-bold text-[var(--ink-2)] line-through decoration-[var(--red)] decoration-2">
                    {row.pain}
                  </p>
                  <p className="v3-body mt-2 text-[14.5px]">{row.painNote}</p>
                </div>

                {/* Стрелка-переход */}
                <div
                  aria-hidden
                  className="hidden items-center justify-center lg:flex"
                >
                  <span className="flex h-11 w-11 items-center justify-center border-2 border-[var(--ink)] bg-[var(--acc)] shadow-[3px_3px_0_var(--ink)]">
                    <ArrowRight className="h-5 w-5" strokeWidth={2.5} />
                  </span>
                </div>

                {/* СТАЛО — зелёная ячейка, решение */}
                <div className="v3-lift relative border-2 border-[var(--ink)] bg-[var(--green-soft)] p-6 shadow-[5px_5px_0_var(--ink)]">
                  <span className="v3-stamp v3-stamp--green absolute -top-3.5 left-5">
                    Стало
                  </span>
                  <p className="v3-mono mt-2 text-[11px] font-semibold tracking-[0.12em] text-[var(--ink-2)] uppercase">
                    {row.feature}
                  </p>
                  <p className="mt-1.5 text-[18px] leading-snug font-bold">{row.solutionTitle}</p>
                  <p className="v3-body mt-2 text-[14.5px]">{row.solution}</p>
                </div>
              </li>
            </V3Reveal>
          ))}
        </ul>
      </div>
    </section>
  );
}
