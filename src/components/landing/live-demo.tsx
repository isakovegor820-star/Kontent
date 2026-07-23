"use client";

// ЖИВОЕ ДЕМО — уровень 3 анимаций из ТЗ 7.4. Главный вау-момент лендинга.
// Это НЕ видео — вёрстка с анимацией.
//
// Показывает весь замкнутый круг: РАЗВЕДКА → ИИ → ОДОБРЕНИЕ → РЕАКЦИИ.
//
// Три правила, которые здесь важнее красоты:
//  1. Цикл 11 секунд, развязка к 5-й. Реальный просмотр hero — 5–10 секунд, поэтому
//     20-секундный цикл показывал большинству только завязку.
//  2. Такт «Одобрить» обязателен. Без него демо учит модели «робот постит сам», которой
//     в продукте нет (подтверждение по умолчанию) — и бьёт в главный страх аудитории
//     на первом же экране.
//  3. Есть пауза (WCAG 2.2.2: движение дольше 5 секунд обязано останавливаться) и
//     остановка за экраном — незачем жечь батарею на невидимой анимации.

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Check, Flame, Pause, Pencil, Play, Sparkles, TrendingUp } from "lucide-react";
import { TelegramIcon, VkIcon } from "@/components/ui/primitives";
import { cn, fmtNum } from "@/lib/utils";

type Phase = "recon" | "ai" | "approve" | "reactions";

// Суммарно 10 600 мс. Кнопка «Одобрить» нажимается на 5,9-й секунде — развязку успевает
// увидеть даже тот, кто смотрит hero шесть секунд и уходит.
const PHASES: { key: Phase; label: string; ms: number }[] = [
  { key: "recon", label: "Разведка", ms: 2200 },
  { key: "ai", label: "ИИ-контент", ms: 2800 },
  { key: "approve", label: "Одобрение", ms: 3000 },
  { key: "reactions", label: "Реакции", ms: 2600 },
];

// Короче прежнего: при цикле в 3 секунды длинный текст не дочитывается, а мельтешит.
const DRAFT =
  "Твой кофе горчит? Дело не в зёрнах, а в помоле.\n\nПоказываю за 40 секунд, как это чинится без новой кофемолки.";

const EASE = [0.22, 1, 0.36, 1] as const;
const POP = [0.34, 1.56, 0.64, 1] as const;

// Через сколько внутри фазы «Одобрение» нажимается кнопка и пост уходит
const APPROVE_AT = 900;
const SENT_AT = 1700;

export function LiveDemo() {
  const reduce = useReducedMotion();

  const [phaseIdx, setPhaseIdx] = useState(0);
  const [typed, setTyped] = useState("");
  const [views, setViews] = useState(0);
  const [approved, setApproved] = useState(false);
  const [sent, setSent] = useState(false);

  // Пауза — по кнопке (WCAG 2.2.2). Видимость — чтобы не крутиться за экраном.
  const [paused, setPaused] = useState(false);
  const [visible, setVisible] = useState(true);

  const hostRef = useRef<HTMLDivElement>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const raf = useRef<number | null>(null);

  const phase = PHASES[phaseIdx].key;
  const running = !paused && visible;

  const clearTimers = useCallback(() => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    if (raf.current) {
      cancelAnimationFrame(raf.current);
      raf.current = null;
    }
  }, []);

  /* --------------------------------------------------------- ВИДИМОСТЬ */
  // Демо за экраном не крутится: на лендинге семь секций, и жечь GPU на невидимой
  // анимации незачем (ТЗ 8.2 — быстро на среднем телефоне).
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const io = new IntersectionObserver(
      ([entry]) => setVisible(entry.isIntersecting),
      { threshold: 0.25 },
    );
    io.observe(host);
    return () => io.disconnect();
  }, []);

  /* ------------------------------------------------------ ВЕДУЩИЙ ЦИКЛ */
  useEffect(() => {
    if (!running) return;
    const t = setTimeout(() => {
      setPhaseIdx((i) => (i + 1) % PHASES.length);
    }, PHASES[phaseIdx].ms);
    return () => clearTimeout(t);
  }, [phaseIdx, running]);

  /* ------------------------------------------- НАПОЛНЕНИЕ ТЕКУЩЕЙ ФАЗЫ */
  // Демо — конечный автомат, синхронизируемый с внешним таймером фаз: сброс визуала
  // на входе в фазу здесь уместен и не создаёт лишних каскадов.
  /* eslint-disable react-hooks/set-state-in-effect -- синхронизация демо с таймером фаз */
  useEffect(() => {
    clearTimers();
    if (!running) return;

    if (phase === "recon") {
      setTyped("");
      setViews(0);
      setApproved(false);
      setSent(false);
    }

    if (phase === "ai") {
      if (reduce) {
        setTyped(DRAFT);
        return;
      }
      // ИИ печатает «пачками», как настоящий стрим
      let i = 0;
      const type = () => {
        i = Math.min(DRAFT.length, i + 3);
        setTyped(DRAFT.slice(0, i));
        if (i < DRAFT.length) timers.current.push(setTimeout(type, 22));
      };
      timers.current.push(setTimeout(type, 260));
    }

    if (phase === "approve") {
      setTyped(DRAFT);
      if (reduce) {
        setApproved(true);
        setSent(true);
        return;
      }
      timers.current.push(setTimeout(() => setApproved(true), APPROVE_AT));
      timers.current.push(setTimeout(() => setSent(true), SENT_AT));
    }

    if (phase === "reactions") {
      setApproved(true);
      setSent(true);
      if (reduce) {
        setViews(12480);
        return;
      }
      const target = 12480;
      const start = performance.now();
      const dur = 1800;
      const tick = (now: number) => {
        const p = Math.min(1, (now - start) / dur);
        setViews(Math.round(target * (1 - Math.pow(1 - p, 3))));
        if (p < 1) raf.current = requestAnimationFrame(tick);
      };
      raf.current = requestAnimationFrame(tick);
    }

    return clearTimers;
  }, [phase, reduce, running, clearTimers]);
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => clearTimers, [clearTimers]);

  return (
    <div className="relative w-full" ref={hostRef}>
      {/* Свечение под панелью — «магнит» */}
      <div
        aria-hidden
        className="absolute -inset-8 -z-10 rounded-[48px] opacity-60 blur-3xl"
        style={{
          background: "radial-gradient(ellipse at 50% 40%, rgb(139 92 246 / 0.35), transparent 65%)",
        }}
      />

      <div
        className="glass-strong overflow-hidden rounded-xl"
        role="img"
        aria-label="Демонстрация: платформа находит залетевший пост конкурента, ИИ пишет пост на эту тему твоим голосом, ты одобряешь его одной кнопкой в боте, пост уходит в Telegram и набирает просмотры"
      >
        {/* Шапка «окна» + рельс шагов + пауза */}
        <div className="flex items-center gap-3 border-b border-line px-4 py-3">
          <div className="flex gap-1.5" aria-hidden>
            <span className="h-2.5 w-2.5 rounded-full bg-danger/60" />
            <span className="h-2.5 w-2.5 rounded-full bg-fire/60" />
            <span className="h-2.5 w-2.5 rounded-full bg-success/60" />
          </div>

          <div className="ml-auto flex items-center gap-1" aria-hidden>
            {PHASES.map((p, i) => (
              <span
                key={p.key}
                className={cn(
                  "hidden rounded-full px-2.5 py-1 text-[13px] font-bold whitespace-nowrap",
                  "transition-all duration-500 sm:inline",
                  i === phaseIdx ? "bg-brand-gradient text-white" : "text-text-3",
                )}
              >
                {p.label}
              </span>
            ))}
          </div>

          {/* WCAG 2.2.2: движение дольше 5 секунд обязано иметь остановку */}
          <button
            type="button"
            onClick={() => setPaused((v) => !v)}
            aria-label={paused ? "Продолжить демонстрацию" : "Остановить демонстрацию"}
            // 44×44 — продуктовое правило тач-таргета. Отрицательный margin не даёт
            // зоне нажатия раздуть шапку окна.
            className={cn(
              "-my-2 flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-full",
              "text-text-3 transition-colors duration-200 hover:bg-surface-inset hover:text-text",
            )}
          >
            {paused ? (
              <Play className="h-4 w-4" strokeWidth={2} aria-hidden />
            ) : (
              <Pause className="h-4 w-4" strokeWidth={2} aria-hidden />
            )}
          </button>
        </div>

        {/* Полоса прогресса фазы */}
        <div className="h-0.5 w-full bg-surface-inset" aria-hidden>
          <motion.div
            key={`${phaseIdx}-${running}`}
            className="h-full bg-brand-gradient"
            initial={{ width: "0%" }}
            animate={{ width: running ? "100%" : "0%" }}
            transition={{ duration: running ? PHASES[phaseIdx].ms / 1000 : 0, ease: "linear" }}
          />
        </div>

        {/* Сцена */}
        <div className="relative h-[400px] p-5 sm:h-[420px]">
          <AnimatePresence mode="wait">
            {/* ——— 1. РАЗВЕДКА: у конкурента залёт ——— */}
            {phase === "recon" && (
              <motion.div
                key="recon"
                initial={{ opacity: 0, y: 14 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.3, ease: EASE }}
                className="flex h-full flex-col justify-center gap-4"
              >
                <p className="text-[13px] font-semibold text-text-2">
                  Следим за конкурентами. Каждые 2–3 часа.
                </p>

                <div className="card-plain relative rounded-md p-4">
                  {/* Тёмный текст, а не белый: янтарный #F59E0B под белым даёт 2.15:1 и
                      валит даже нетекстовый порог. Как заливка под тёмным — 8.31:1. */}
                  <span className="fire-ring absolute -top-2.5 -right-2.5 inline-flex items-center gap-1 rounded-full bg-fire px-2.5 py-1 text-[13px] font-extrabold text-[#0f172a]">
                    <Flame className="h-3.5 w-3.5" aria-hidden />
                    ×7,8
                  </span>

                  <div className="flex items-center gap-3">
                    <span
                      className="h-9 w-9 shrink-0 rounded-full"
                      style={{
                        background: "linear-gradient(135deg, hsl(26 80% 62%), hsl(26 80% 48%))",
                      }}
                      aria-hidden
                    />
                    <div className="min-w-0">
                      <p className="text-[14px] font-bold text-text">Сварил сам</p>
                      <p className="text-[13px] text-text-2">@svaril_sam · 38 400 подписчиков</p>
                    </div>
                  </div>

                  <p className="mt-3 text-[14px] leading-snug text-text">
                    «Почему твой кофе горчит? Дело не в зёрнах. Показываю за 40 секунд →»
                  </p>

                  <div className="nums mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] font-semibold">
                    <span className="text-fire-text">71 400 просмотров</span>
                    <span className="text-text-2">медиана канала — 9 200</span>
                  </div>
                </div>

                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 0.5, duration: 0.3 }}
                  className="rounded-md bg-info-soft p-3"
                >
                  <p className="text-[13px] leading-relaxed text-info-text">
                    <strong>Вывод ИИ:</strong> сработала связка «обвинение в первой секунде +
                    быстрое решение». Формат — вертикалка до 40 секунд.
                  </p>
                </motion.div>
              </motion.div>
            )}

            {/* ——— 2. ИИ ПИШЕТ ПОСТ В ТВОЁМ СТИЛЕ ——— */}
            {phase === "ai" && (
              <motion.div
                key="ai"
                initial={{ opacity: 0, y: 14 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.3, ease: EASE }}
                className="flex h-full flex-col gap-3"
              >
                <div className="flex items-center gap-2">
                  <Sparkles className="h-4 w-4 text-brand" aria-hidden />
                  <p className="text-[13px] font-semibold text-text-2">
                    ИИ пишет пост на эту тему — но твоим голосом
                  </p>
                </div>

                <div className="card-plain flex-1 rounded-md p-4">
                  <p
                    className={cn(
                      "text-[15px] leading-relaxed whitespace-pre-wrap text-text",
                      typed.length < DRAFT.length && "caret",
                    )}
                  >
                    {typed}
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-full bg-surface-inset px-2.5 py-1 text-[13px] font-semibold text-text-2">
                    опора: залёт «Сварил сам»
                  </span>
                  <span className="rounded-full bg-surface-inset px-2.5 py-1 text-[13px] font-semibold text-text-2">
                    твой тон: на «ты», без пафоса
                  </span>
                </div>
              </motion.div>
            )}

            {/* ——— 3. ТЫ ОДОБРЯЕШЬ — И ТОЛЬКО ТОГДА ПОСТ УХОДИТ ——— */}
            {/* Самый важный такт демо: без него продукт читается как «робот постит сам». */}
            {phase === "approve" && (
              <motion.div
                key="approve"
                initial={{ opacity: 0, y: 14 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.3, ease: EASE }}
                className="flex h-full flex-col justify-center gap-3"
              >
                <p className="text-[13px] font-semibold text-text-2">
                  Готовый пост приходит в бот. Без твоего «ок» ничего не выйдет.
                </p>

                {/* Сообщение бота с инлайн-клавиатурой — как в Telegram */}
                <div className="overflow-hidden rounded-md border border-line bg-surface shadow-soft">
                  <div className="p-3.5">
                    <p className="flex items-center gap-1.5 text-[13px] font-bold text-brand">
                      Аврора
                      <span className="rounded-[5px] bg-surface-inset px-1.5 py-0.5 text-[13px] font-semibold text-text-2">
                        бот
                      </span>
                    </p>
                    <p className="mt-1.5 line-3 text-[14px] leading-relaxed text-text">{DRAFT}</p>
                    <p className="mt-2 text-[13px] font-semibold text-text-2">
                      Отправить в «Кофе и код» сегодня в 10:00?
                    </p>
                  </div>

                  <div className="grid grid-cols-2 gap-px border-t border-line bg-line">
                    {/* Кнопка «нажимается» сама — это макет, показывающий твой клик */}
                    <motion.span
                      className={cn(
                        "flex min-h-11 items-center justify-center gap-1.5 px-3 py-2.5",
                        "text-center text-[13px] font-bold transition-colors duration-200",
                        approved ? "bg-success text-white" : "bg-surface text-brand",
                      )}
                      animate={approved && !reduce ? { scale: [1, 0.94, 1] } : {}}
                      transition={{ duration: 0.28, ease: POP }}
                    >
                      {approved ? (
                        <Check className="h-3.5 w-3.5" strokeWidth={3} aria-hidden />
                      ) : null}
                      Одобрить
                    </motion.span>
                    <span className="flex min-h-11 items-center justify-center gap-1.5 bg-surface px-3 py-2.5 text-center text-[13px] font-semibold text-text-2">
                      <Pencil className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
                      Править
                    </span>
                  </div>
                </div>

                {/* Развязка: ушло в обе сети — Telegram и VK публикуют по-настоящему. */}
                <div className="min-h-[52px]">
                  <AnimatePresence>
                    {sent && (
                      <motion.div
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: reduce ? 0 : 0.35, ease: POP }}
                        className="flex items-center gap-3 rounded-md border border-success/30 bg-success-soft p-3"
                      >
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-success text-white">
                          <Check className="h-4 w-4" strokeWidth={3} aria-hidden />
                        </span>
                        <p className="text-[13px] leading-snug font-bold text-success-text">
                          Пост ушёл в Telegram и VK. Публикует сервер — ноутбук можно закрыть.
                        </p>
                        <span className="ml-auto flex shrink-0 items-center gap-1 text-success-text">
                          <TelegramIcon className="h-5 w-5" />
                          <VkIcon className="h-5 w-5" />
                        </span>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </motion.div>
            )}

            {/* ——— 4. РЕАКЦИИ: ЦИФРЫ РАСТУТ, ЦИКЛ ЗАМЫКАЕТСЯ ——— */}
            {phase === "reactions" && (
              <motion.div
                key="reactions"
                initial={{ opacity: 0, y: 14 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.3, ease: EASE }}
                className="flex h-full flex-col justify-center gap-4"
              >
                <p className="text-[13px] font-semibold text-text-2">
                  Смотрим, что зашло — и учимся на этом
                </p>

                <div className="card-plain rounded-md p-5">
                  <p className="text-[13px] font-semibold text-text-2">Просмотров за 6 часов</p>
                  <p className="nums mt-1 text-[44px] leading-none font-extrabold text-gradient">
                    {fmtNum(views)}
                  </p>
                  <p className="mt-2 inline-flex items-center gap-1.5 text-[13px] font-bold text-success-text">
                    <TrendingUp className="h-4 w-4" aria-hidden />в 2,4 раза выше твоей нормы
                  </p>

                  <div className="mt-4 flex h-16 items-end gap-1.5" aria-hidden>
                    {[22, 30, 26, 38, 34, 48, 44, 62, 58, 78, 88, 100].map((h, i) => (
                      <motion.div
                        key={i}
                        initial={{ height: "8%" }}
                        animate={{ height: `${h}%` }}
                        transition={{ delay: 0.1 + i * 0.035, duration: 0.4, ease: EASE }}
                        className={cn(
                          "flex-1 rounded-t-[3px]",
                          i >= 9 ? "bg-brand-gradient" : "bg-surface-inset",
                        )}
                      />
                    ))}
                  </div>
                </div>

                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 1, duration: 0.4 }}
                  className="flex items-center justify-center gap-2 rounded-md bg-info-soft px-4 py-3 text-center"
                >
                  <motion.span
                    animate={reduce || !running ? {} : { rotate: 360 }}
                    transition={{ duration: 2.4, ease: "linear", repeat: Infinity }}
                    className="text-brand"
                    aria-hidden
                  >
                    <svg viewBox="0 0 16 16" className="h-4 w-4">
                      <path
                        d="M14 8a6 6 0 1 1-1.8-4.3M13 1v3h-3"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        fill="none"
                      />
                    </svg>
                  </motion.span>
                  <p className="text-[13px] font-semibold text-info-text">
                    Сработало → запомнили → следующая разведка уже умнее
                  </p>
                </motion.div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* Честная подпись — это вёрстка, а не видео */}
      <p className="mt-3 text-center text-[13px] text-text-2">
        Это не видео — это интерфейс платформы. Крутится сам, 10 секунд.
      </p>
    </div>
  );
}
