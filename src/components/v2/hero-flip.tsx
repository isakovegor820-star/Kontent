"use client";

// HERO + LAYER FLIP — «один трюк» прототипа v2.
// Сцена 280vh со sticky-кадром: при скролле hero уходит вглубь
// (Z: 0→−560, rotateY: 0→−12°), а окно живого демо выравнивается из глубины
// (Z: −720→0, rotateY: 9→0). Последние ~25% скролла — dwell на демо,
// потом кадр естественно отлипает и дальше обычный скролл. Никакого джекинга:
// прогресс привязан к нативному скроллу, не к колесу.
//
// Флип включён только на десктопе с мышью (≥1024px, hover, fine pointer) и без
// reduced-motion. Остальные получают обычный поток: hero → демо появляется
// whileInView. Мастхед живёт внутри sticky-контейнера, чтобы сцена начиналась
// от y=0 — иначе липкий блок включался бы позже и подсказка с HUD
// проваливались под фолд на первом экране.

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  motion,
  useMotionTemplate,
  useMotionValue,
  useReducedMotion,
  useTransform,
} from "motion/react";
import { ArrowRight } from "lucide-react";
import { LiveDemoPaper } from "./live-demo-paper";

const EASE = [0.22, 1, 0.36, 1] as const;
const FLIP_QUERY = "(min-width: 1024px) and (hover: hover) and (pointer: fine)";

function useMedia(query: string) {
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setMatches(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

const FACTS = [
  { n: "8", label: "сервисов протестировали" },
  { n: "104", label: "агента разведки" },
  { n: "0 ₽", label: "навсегда" },
] as const;

export function HeroFlip() {
  const reduce = useReducedMotion();
  const wide = useMedia(FLIP_QUERY);
  const flip = wide && !reduce;

  const sceneRef = useRef<HTMLElement>(null);

  /* Прогресс сцены считаем вручную, а не через useScroll:
     motion v12 перехватывает scroll-linked MotionValues в нативные
     ViewTimeline-анимации (WAAPI), а ViewTimeline меряет видимость САМОГО
     слоя — который в этот момент крутится в 3D и отлипает со sticky.
     Результат — немонотонный мусор. Ручной useMotionValue такой
     пометки не несёт, и весь трюк остаётся на предсказуемом JS-пути. */
  const p = useMotionValue(0);
  useEffect(() => {
    if (!flip) return;
    const scene = sceneRef.current;
    if (!scene) return;

    let top = 0;
    let range = 1;
    const update = () => {
      const v = (window.scrollY - top) / range;
      p.set(v < 0 ? 0 : v > 1 ? 1 : v);
    };
    const measure = () => {
      top = scene.getBoundingClientRect().top + window.scrollY;
      range = Math.max(1, scene.offsetHeight - window.innerHeight);
      update();
    };

    measure();
    document.fonts?.ready.then(measure).catch(() => {});
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", measure);
    };
  }, [flip, p]);

  // Hero уходит вглубь и гаснет; лёгкий подъём добавляет «уезжанию» воздуха
  const heroZ = useTransform(p, [0, 1], [0, -560]);
  const heroRy = useTransform(p, [0, 1], [0, -12]);
  const heroY = useTransform(p, [0, 1], [0, -40]);
  const heroO = useTransform(p, [0.3, 0.6], [1, 0]);
  const heroT = useMotionTemplate`perspective(1300px) translate3d(0, ${heroY}px, ${heroZ}px) rotateY(${heroRy}deg)`;

  // Стикеры на правой колонке дрейфуют вниз, уходя раньше текста
  const stickerDrift = useTransform(p, [0, 1], [0, 130]);

  // Демо выезжает из глубины и проявляется
  const demoZ = useTransform(p, [0, 1], [-720, 0]);
  const demoRy = useTransform(p, [0, 1], [9, 0]);
  const demoO = useTransform(p, [0.34, 0.62], [0, 1]);
  const demoPE = useTransform(p, (v) => (v > 0.55 ? ("auto" as const) : ("none" as const)));
  const demoT = useMotionTemplate`perspective(1300px) translate3d(0, 0px, ${demoZ}px) rotateY(${demoRy}deg)`;

  // Подсказка гаснет сразу, чтобы не спорить с трюком
  const hintO = useTransform(p, [0, 0.08], [1, 0]);

  const headline = ["Соцсети,", "которые ведут"];

  return (
    <section ref={sceneRef} className={flip ? "relative h-[280vh]" : "relative"}>
      <div className={flip ? "sticky top-0 h-dvh overflow-hidden" : "relative overflow-hidden"}>
        {/* Мастхед: в flip-режиме — поверх сцены, в потоке — обычный блок */}
        <header className={flip ? "v2-masthead absolute inset-x-0 top-0 z-20" : "v2-masthead"}>
          <div className="mx-auto flex w-full max-w-[1280px] items-center gap-6 px-6 py-4 lg:px-12">
            <Link
              href="/v2"
              className="v2-display text-[22px] leading-none font-bold"
              style={{ color: "var(--ink)" }}
            >
              Аврора<span style={{ color: "var(--accent)" }}>.</span>
            </Link>
            <p
              className="v2-mono mx-auto hidden text-[11px] uppercase sm:block"
              style={{ color: "var(--ink-2)", letterSpacing: "0.18em" }}
            >
              Вып. № 01 · Соцсети, которые ведут себя сами · 2026
            </p>
            <Link href="/register" className="v2-btn v2-btn-sm ml-auto sm:ml-0">
              Ранний доступ
            </Link>
          </div>
        </header>

        {/* ——— СЛОЙ HERO ——— */}
        <motion.div
          className={flip ? "v2-flip-layer absolute inset-0" : "relative"}
          style={flip ? { transform: heroT, opacity: heroO } : undefined}
        >
          <div
            className={`mx-auto flex h-full w-full max-w-[1280px] items-center px-6 lg:px-12 ${flip ? "pt-[76px]" : ""}`}
          >
            <div className="grid w-full grid-cols-1 items-center gap-10 py-16 lg:grid-cols-12">
              {/* Текстовая колонка — 7 из 12 */}
              <div className="lg:col-span-7">
                <p className="v2-kicker v2-mono">№ 01 — Обещание</p>

                <h1
                  className="v2-display mt-7 text-[clamp(2.9rem,6.4vw,6rem)] leading-[1.02] font-bold"
                  style={{ color: "var(--ink)" }}
                >
                  {headline.map((line, i) => (
                    <span key={line} className="block overflow-hidden whitespace-nowrap pb-[0.08em]">
                      <motion.span
                        className="block"
                        initial={reduce ? false : { y: "112%" }}
                        animate={{ y: "0%" }}
                        transition={{ duration: 0.6, ease: EASE, delay: 0.08 * i }}
                      >
                        {line}
                      </motion.span>
                    </span>
                  ))}
                  <span className="block overflow-hidden whitespace-nowrap pb-[0.08em]">
                    <motion.span
                      className="block"
                      initial={reduce ? false : { y: "112%" }}
                      animate={{ y: "0%" }}
                      transition={{ duration: 0.6, ease: EASE, delay: 0.16 }}
                    >
                      <em>себя</em> <em style={{ color: "var(--accent)" }}>сами</em>
                    </motion.span>
                  </span>
                </h1>

                <motion.div
                  initial={reduce ? false : { opacity: 0, y: 18 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.55, ease: EASE, delay: 0.28 }}
                >
                  <p className="v2-body mt-7 max-w-[34em] text-[17px]">
                    Платформа сама следит за конкурентами, находит залетающие темы, пишет посты{" "}
                    <span className="v2-marker">твоим голосом</span> и публикует их в Telegram и VK —
                    по расписанию, с сервера.
                  </p>

                  <div className="mt-9 flex flex-wrap items-center gap-x-6 gap-y-4">
                    <Link href="/register" className="v2-btn">
                      Забрать ранний доступ
                      <ArrowRight className="h-5 w-5" strokeWidth={2.2} aria-hidden />
                    </Link>
                    <a href="#circle" className="v2-btn-ghost">
                      Как это работает
                    </a>
                  </div>

                  <p
                    className="v2-mono mt-6 flex items-center gap-2.5 text-[11px] uppercase"
                    style={{ color: "var(--ink-2)", letterSpacing: "0.14em" }}
                  >
                    <span className="v2-live-dot" aria-hidden />
                    Без карты · Без пейволов · TG и VK уже публикуют
                  </p>

                  <div
                    className="v2-hero-facts relative mt-10 grid grid-cols-3 gap-4 pt-6"
                    style={{ borderTop: "1px solid var(--rule-strong)" }}
                  >
                    <span
                      className="v2-display absolute -top-[0.6em] left-0 pr-2 italic"
                      style={{ background: "var(--paper)", color: "var(--ink-2)" }}
                      aria-hidden
                    >
                      —
                    </span>
                    {FACTS.map((f) => (
                      <div key={f.label}>
                        <p className="v2-display text-[40px] leading-none font-bold" style={{ color: "var(--ink)" }}>
                          {f.n}
                        </p>
                        <p
                          className="v2-mono mt-2 text-[10px] uppercase"
                          style={{ color: "var(--ink-2)", letterSpacing: "0.14em" }}
                        >
                          {f.label}
                        </p>
                      </div>
                    ))}
                  </div>
                </motion.div>
              </div>

              {/* Стикеры-врезки — 4 из 12, асимметрия сетки */}
              <motion.div
                className="flex flex-col items-start gap-6 lg:col-span-4 lg:col-start-9 lg:items-end"
                style={flip ? { y: stickerDrift } : undefined}
                initial={reduce ? false : { opacity: 0, y: 24 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.55, ease: EASE, delay: 0.42 }}
              >
                <span className="v2-sticker" style={{ transform: "rotate(-2deg)" }}>
                  ×7,8 — залёт недели
                  <br />в нише «кофе»
                </span>
                <span
                  className="v2-sticker lg:mr-10"
                  style={{ background: "var(--accent)", color: "var(--sheet)", transform: "rotate(1.5deg)" }}
                >
                  Одобрено за 6 секунд
                </span>
                <p className="v2-display text-[16px] italic lg:text-right" style={{ color: "var(--ink-2)" }}>
                  — из вчерашней разведки
                  <br />
                  @svaril_sam
                </p>
              </motion.div>
            </div>
          </div>
        </motion.div>

        {/* ——— СЛОЙ ДЕМО ——— */}
        {flip ? (
          <motion.div
            className="v2-flip-layer absolute inset-0"
            style={{ transform: demoT, opacity: demoO, pointerEvents: demoPE }}
          >
            <div className="mx-auto flex h-full w-full max-w-[1280px] items-center px-6 pt-[76px] lg:px-12">
              <div className="relative mx-auto w-full max-w-[880px]">
                <span
                  className="v2-sticker v2-mono absolute -top-5 left-5 z-10 hidden sm:inline-block"
                  style={{ transform: "rotate(-2deg)" }}
                >
                  Не видео — живой интерфейс
                </span>
                <LiveDemoPaper />
                <p
                  className="v2-mono mt-5 text-center text-[11px] uppercase"
                  style={{ color: "var(--ink-2)", letterSpacing: "0.16em" }}
                >
                  Полный круг: разведка → ИИ → твоё «да» → реакции. 10 секунд.
                </p>
              </div>
            </div>
          </motion.div>
        ) : (
          <div className="mx-auto w-full max-w-[1280px] px-6 pb-20 lg:px-12">
            <motion.div
              initial={reduce ? false : { opacity: 0, y: 24 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-80px" }}
              transition={{ duration: 0.55, ease: EASE }}
              className="relative mx-auto w-full max-w-[880px]"
            >
              <span
                className="v2-sticker v2-mono absolute -top-5 left-5 z-10 hidden sm:inline-block"
                style={{ transform: "rotate(-2deg)" }}
              >
                Не видео — живой интерфейс
              </span>
              <LiveDemoPaper />
              <p
                className="v2-mono mt-5 text-center text-[11px] uppercase"
                style={{ color: "var(--ink-2)", letterSpacing: "0.16em" }}
              >
                Полный круг: разведка → ИИ → твоё «да» → реакции. 10 секунд.
              </p>
            </motion.div>
          </div>
        )}

        {/* Подсказка + HUD — только в flip-режиме */}
        {flip && (
          <>
            <motion.p
              className="v2-mono absolute inset-x-0 bottom-7 z-20 text-center text-[11px] uppercase"
              style={{ opacity: hintO, color: "var(--ink-2)", letterSpacing: "0.16em" }}
            >
              Листай ↓ — сейчас покажем сам продукт
            </motion.p>
            <div className="absolute right-8 bottom-7 z-20 flex items-center gap-3">
              <span className="v2-mono text-[11px]" style={{ color: "var(--ink-2)" }}>
                01 / 02
              </span>
              <span className="h-[2px] w-[120px]" style={{ background: "var(--rule)" }} aria-hidden>
                <motion.span
                  className="block h-full origin-left"
                  style={{ scaleX: p, background: "var(--accent)" }}
                />
              </span>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
