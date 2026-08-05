// Соцдоказательство v3: одна честная цепочка «идея → черновик → пост в канале».
// Живых кейсов пока нет — поэтому подпись честная: «из нашего тестового канала».
import { ArrowRight, Eye } from "lucide-react";
import { V3Reveal } from "./reveal";

const POST_TEXT =
  "Кофе горчит не потому, что «зерно плохое». Чаще всего — помол мельче, чем нужно твоей турке. Вода дольше контактирует с частицами и вытягивает лишнюю горечь. Сделай помол на два клика крупнее — и вкус станет чище уже завтра утром.";

function ChainArrow() {
  return (
    <div aria-hidden className="flex items-center justify-center lg:h-full">
      <span className="flex h-11 w-11 rotate-90 items-center justify-center border-2 border-[var(--ink)] bg-[var(--acc)] shadow-[3px_3px_0_var(--ink)] lg:rotate-0">
        <ArrowRight className="h-5 w-5" strokeWidth={2.5} />
      </span>
    </div>
  );
}

export function V3PostProof() {
  return (
    <section aria-labelledby="v3-proof-title" className="py-20 sm:py-28">
      <div className="v3-wrap">
        <V3Reveal className="mx-auto max-w-2xl text-center">
          <p className="v3-kicker v3-kicker--center justify-center">Доказательство</p>
          <h2
            id="v3-proof-title"
            className="v3-display mt-6 text-[clamp(1.9rem,4.4vw,3.2rem)] leading-[1.04] font-black uppercase"
          >
            Пост, который написала Аврора
          </h2>
          <p className="v3-mono mx-auto mt-5 max-w-lg text-[11.5px] leading-relaxed tracking-[0.08em] text-[var(--ink-2)] uppercase">
            Из нашего тестового канала — показываем как есть
          </p>
        </V3Reveal>

        <V3Reveal delay={0.08} className="mt-14">
          <ol className="grid items-stretch gap-6 lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1.2fr)_auto_minmax(0,1.2fr)]">
            {/* 1. Карточка идеи */}
            <li className="v3-card v3-lift relative flex flex-col p-6">
              <span className="v3-stamp v3-stamp--acc absolute -top-3.5 left-5">01 · Идея</span>
              <span className="v3-chip v3-chip--acc mt-2 w-fit">Создать публикацию</span>
              <p className="mt-3 text-[17px] leading-snug font-bold">Кофе горчит? Дело в помоле</p>
              <ul className="mt-3 space-y-1.5">
                {["Обвинение в первой секунде", "Решение — за 40 секунд"].map((l) => (
                  <li key={l} className="flex items-start gap-2 text-[14px] text-[var(--ink-2)]">
                    <span aria-hidden className="mt-[7px] h-1.5 w-1.5 shrink-0 bg-[var(--ink)]" />
                    {l}
                  </li>
                ))}
              </ul>
              <span className="v3-chip mt-4 w-fit">Видео · 40 сек</span>
            </li>

            <ChainArrow />

            {/* 2. Черновик */}
            <li className="v3-card v3-lift relative flex flex-col p-6">
              <span className="v3-stamp absolute -top-3.5 left-5">02 · Черновик</span>
              <p className="v3-mono mt-2 text-[11px] font-semibold tracking-[0.12em] text-[var(--ink-2)] uppercase">
                голос канала «Кофе и код»
              </p>
              <p className="mt-3 text-[14.5px] leading-relaxed">{POST_TEXT}</p>
              <div className="mt-4 flex flex-wrap gap-2">
                <span className="v3-chip">#кофе</span>
                <span className="v3-chip">#помол</span>
              </div>
            </li>

            <ChainArrow />

            {/* 3. Пост в канале */}
            <li className="v3-card v3-lift relative flex flex-col p-0">
              <span className="v3-stamp v3-stamp--green absolute -top-3.5 left-5 z-10">
                03 · Опубликовано
              </span>
              <div className="flex items-center gap-3 border-b-2 border-[var(--ink)] bg-[var(--paper)] px-5 py-3.5">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center border-2 border-[var(--ink)] bg-[var(--ink)] text-[13px] font-black text-[var(--paper)]">
                  К
                </span>
                <div className="min-w-0">
                  <p className="truncate text-[14.5px] leading-tight font-bold">Кофе и код</p>
                  <p className="v3-mono truncate text-[10.5px] tracking-[0.06em] text-[var(--ink-2)] uppercase">
                    канал · 3 240 подписчиков
                  </p>
                </div>
              </div>
              <div className="flex flex-1 flex-col p-5">
                <p className="text-[14.5px] leading-relaxed">{POST_TEXT}</p>
                <p className="v3-mono mt-4 flex items-center gap-4 text-[11px] tracking-[0.06em] text-[var(--ink-2)] uppercase">
                  <span className="flex items-center gap-1.5">
                    <Eye className="h-3.5 w-3.5" strokeWidth={2.5} aria-hidden />
                    12 400
                  </span>
                  <span className="ml-auto">12:00</span>
                </p>
              </div>
            </li>
          </ol>
        </V3Reveal>
      </div>
    </section>
  );
}
