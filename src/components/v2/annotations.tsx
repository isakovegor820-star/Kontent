"use client";

// СЕКЦИЯ «ОДИН КРУГ» — то, что пользователь только что видел в демо, разложенное
// по шагам. Origami-scroll: четыре колонки стоят на разной высоте и с разной
// скоростью «собираются» в ровную линейку, пока секция входит в экран.
// Скролл обычный, никакого джекинга — параллакс scrubbed, поэтому ощущается
// как продолжение пальца, а не как самодеятельность страницы.

import { useRef } from "react";
import Link from "next/link";
import { motion, useReducedMotion, useScroll, useTransform } from "motion/react";
import { ArrowRight } from "lucide-react";

const EASE = [0.22, 1, 0.36, 1] as const;

const STEPS = [
  {
    n: "1",
    title: "Разведка",
    text: "Следим за конкурентами каждые 2–3 часа. Залёт видим раньше, чем его автор допьёт кофе.",
    tag: "×7,8 от нормы",
  },
  {
    n: "2",
    title: "ИИ-черновик",
    text: "Пишет пост на тему залёта — твоим голосом, с опорой на факты твоего канала.",
    tag: "40 секунд",
  },
  {
    n: "3",
    title: "Твоё «да»",
    text: "Готовый пост приходит в бот. Без одобрения не выйдет ничего — ни при каких настройках.",
    tag: "1 кнопка",
  },
  {
    n: "4",
    title: "Реакции",
    text: "Считаем просмотры, учимся на залетах. Следующая разведка уже умнее этой.",
    tag: "12 480 за 6 часов",
  },
] as const;

export function Annotations() {
  const reduce = useReducedMotion();
  const ref = useRef<HTMLElement>(null);

  // Прогресс входа секции: 0 — верх секции коснулся низа экрана,
  // 1 — верх дошёл до 40% высоты экрана. Дальше колонки стоят ровно.
  const { scrollYProgress: p } = useScroll({
    target: ref,
    offset: ["start end", "start 0.4"],
  });

  // У каждой колонки — своя дистанция «сборки»: асимметрия читается и в покое,
  // и в движении. Поворот ≤2°, чтобы не мельтешил.
  const y1 = useTransform(p, [0, 1], [56, 0]);
  const y2 = useTransform(p, [0, 1], [128, 0]);
  const y3 = useTransform(p, [0, 1], [84, 0]);
  const y4 = useTransform(p, [0, 1], [160, 0]);
  const r2 = useTransform(p, [0, 1], [1.6, 0]);
  const r4 = useTransform(p, [0, 1], [-1.8, 0]);

  const shifts = [y1, y2, y3, y4];
  const rots = [undefined, r2, undefined, r4];

  return (
    <section ref={ref} className="relative" style={{ borderTop: "2px solid var(--ink)" }}>
      <div className="mx-auto w-full max-w-[1280px] px-6 py-20 lg:px-12 lg:py-28">
        <p className="v2-kicker v2-mono">№ 02 — Что ты сейчас видел</p>

        <div className="mt-7 grid grid-cols-1 items-end gap-6 lg:grid-cols-12">
          <h2
            className="v2-display text-[clamp(2.2rem,4.6vw,4rem)] lg:col-span-8"
            style={{ color: "var(--ink)" }}
          >
            Один круг — от чужого залёта
            <br />
            до <em style={{ color: "var(--accent)" }}>твоих</em> просмотров
          </h2>
          <p className="v2-body text-[16.5px] lg:col-span-4 lg:pb-2">
            Это не четыре фичи, а один замкнутый цикл. Он повторяется каждую неделю —
            и каждый раз точнее попадает в твою аудиторию.
          </p>
        </div>

        {/* Origami-колонки */}
        <div className="mt-14 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4 lg:gap-7">
          {STEPS.map((step, i) => (
            <motion.article
              key={step.n}
              style={reduce ? undefined : { y: shifts[i], rotate: rots[i] }}
              className={`v2-sheet flex flex-col p-6 ${i % 2 === 1 ? "lg:mt-12" : ""}`}
            >
              <div className="flex items-baseline justify-between">
                <span
                  className="v2-display text-[44px] leading-none italic"
                  style={{ color: "var(--accent)" }}
                >
                  {step.n}.
                </span>
                <span className="v2-mono text-[10.5px]" style={{ color: "var(--ink-2)" }}>
                  {step.tag}
                </span>
              </div>
              <h3 className="v2-display mt-5 text-[24px]" style={{ color: "var(--ink)", fontWeight: 700 }}>
                {step.title}
              </h3>
              <p className="v2-body mt-3 text-[14.5px]">{step.text}</p>
            </motion.article>
          ))}
        </div>

        {/* Врезка + финальный призыв */}
        <div className="mt-20 flex flex-col items-center text-center">
          <p
            className="v2-display max-w-[16em] text-[clamp(1.7rem,3.4vw,2.6rem)]"
            style={{ color: "var(--ink)", lineHeight: 1.15, fontWeight: 600 }}
          >
            Всё это — без твоего участия.{" "}
            <em>Ты только говоришь «да».</em>
          </p>

          <motion.div
            initial={reduce ? false : { opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-60px" }}
            transition={{ duration: 0.55, ease: EASE }}
            className="mt-10"
          >
            <Link href="/register" className="v2-btn">
              Забрать ранний доступ
              <ArrowRight className="h-5 w-5" strokeWidth={2.2} aria-hidden />
            </Link>
          </motion.div>

          <p className="v2-mono mt-5 text-[11.5px]" style={{ color: "var(--ink-2)" }}>
            Бесплатно · Без карты · Из России
          </p>
        </div>
      </div>

      {/* Подвал-полоса */}
      <footer style={{ borderTop: "1px solid var(--rule-strong)" }}>
        <div className="v2-mono mx-auto flex w-full max-w-[1280px] flex-col items-center justify-between gap-2 px-6 py-6 text-[11px] sm:flex-row lg:px-12" style={{ color: "var(--ink-2)" }}>
          <span>Аврора · лист ожидания открыт</span>
          <span>Набрано вручную: бумага, чернила, киноварь</span>
        </div>
      </footer>
    </section>
  );
}
