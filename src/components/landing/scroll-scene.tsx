"use client";

// СКРОЛЛ-СЦЕНА — видеосекция, которую человек перематывает сам.
//
// Это НЕ <video>. Скраб видео по скроллу на iOS Safari дёргается: декодер не
// успевает за произвольным seek. Секвенция кадров ходит мгновенно в обе
// стороны, потому что декодировать нечего.
//
// Три правила, которые здесь важнее красоты:
//  1. Кадры грузятся ЛЕНИВО — за экран до входа секции. Секция весит ~3 МБ,
//     их на лендинге пять; загрузить всё вперёд = убить ТЗ 8.2 («быстро на
//     среднем телефоне»). Пока человек не подошёл — не тратим ни байта.
//  2. Раскладка при prefers-reduced-motion живёт в CSS, а не в JS: медиазапрос
//     не создаёт рассинхрона разметки при гидрации (та же грабля, что разобрана
//     в pains.tsx). JS про reduce знает только одно — какой кадр рисовать.
//  3. Смысл несёт текст битов, а не картинка. Кадр — иллюстрация, поэтому
//     canvas для скринридера скрыт, а биты — обычный текст в потоке.

import { useCallback, useEffect, useRef, useState } from "react";
import { useReducedMotion } from "motion/react";
import { cn } from "@/lib/utils";

export type Beat = {
  /** Прогресс сцены (0…1), на котором бит загорается */
  at: number;
  eyebrow: string;
  title: string;
  body: string;
};

type Props = {
  /** Папка секвенции: public/scroll/<concept>/{d,m}/01.jpg… */
  concept: string;
  /** Сколько кадров в секвенции — должно совпадать с --count у frames.mjs */
  frames: number;
  beats: Beat[];
  /** Сколько прокрутки уходит на пролёт. 340 = 3.4 экрана. */
  scrollVh?: number;
  /** Что читает скринридер вместо картинки */
  alt: string;
  className?: string;
};

const MOBILE = "(max-width:860px), (hover:none) and (pointer:coarse)";

export function ScrollScene({
  concept,
  frames: frameCount,
  beats,
  scrollVh = 340,
  alt,
  className,
}: Props) {
  const reduce = useReducedMotion();

  const sceneRef = useRef<HTMLElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imagesRef = useRef<HTMLImageElement[]>([]);
  const rafRef = useRef(0);
  const curRef = useRef(-1);
  const sizeRef = useRef({ w: 0, h: 0 });

  const [ready, setReady] = useState(0);
  const [near, setNear] = useState(false);
  const [active, setActive] = useState(0);

  const loaded = ready === frameCount && frameCount > 0;

  /* ------------------------------------------------------------ ОТРИСОВКА */
  // object-fit: cover вручную — canvas сам так не умеет.

  const draw = useCallback((i: number, force = false) => {
    if (!force && i === curRef.current) return;
    const canvas = canvasRef.current;
    const img = imagesRef.current[i];
    if (!canvas || !img?.complete || !img.naturalWidth) return;

    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return;

    curRef.current = i;
    const { width: cw, height: ch } = canvas;
    const s = Math.max(cw / img.naturalWidth, ch / img.naturalHeight);
    const w = img.naturalWidth * s;
    const h = img.naturalHeight * s;
    ctx.drawImage(img, (cw - w) / 2, (ch - h) / 2, w, h);
  }, []);

  const fit = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const r = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(window.innerWidth * r);
    const h = Math.round(window.innerHeight * r);
    if (!w || !h) return; // вьюпорт ещё не готов — не портим холст нулём

    // На телефоне прячущаяся адресная строка меняет только высоту. Пересчитывать
    // холст на каждый её чих — это дёрганье и лишние перерисовки.
    const degenerate = !canvas.width || !canvas.height;
    const { w: lw, h: lh } = sizeRef.current;
    if (!degenerate && w === lw && Math.abs(h - lh) < h * 0.2) return;

    canvas.width = w;
    canvas.height = h;
    sizeRef.current = { w, h };
    draw(Math.max(0, curRef.current), true);
  }, [draw]);

  /* ------------------------------------------------- ЛЕНИВАЯ ПОДКАЧКА */
  // Секция начинает грузиться за экран до входа: к моменту, когда человек
  // до неё домотал, кадры уже в памяти, и скраб идёт без дыр.

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setNear(true);
          io.disconnect(); // грузим один раз и навсегда
        }
      },
      { rootMargin: "100% 0px" },
    );
    io.observe(scene);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!near) return;
    let alive = true;
    const mobile = window.matchMedia(MOBILE).matches;
    const dir = `/scroll/${concept}/${mobile ? "m" : "d"}`;

    const images = Array.from({ length: frameCount }, (_, i) => {
      const img = new Image();
      img.decoding = "async";
      img.src = `${dir}/${String(i + 1).padStart(2, "0")}.jpg`;
      // Кадр не пришёл — засчитываем его как готовый: одна дырка в секвенции
      // не повод держать человека на «73%» вечно.
      const done = () => {
        if (!alive) return;
        setReady((n) => n + 1);
        if (i === 0) fit();
      };
      img.onload = done;
      img.onerror = done;
      return img;
    });

    imagesRef.current = images;
    return () => {
      alive = false;
      images.forEach((img) => {
        img.onload = null;
        img.onerror = null;
      });
    };
  }, [near, concept, frameCount, fit]);

  /* ---------------------------------------------------------- СКРАБ */

  useEffect(() => {
    if (!loaded) return;

    const tick = () => {
      rafRef.current = 0;
      const scene = sceneRef.current;
      if (!scene) return;

      // При reduce сцена схлопнута в один экран и не мотается: показываем
      // первый кадр как обычную картинку.
      let p = 0;
      if (!reduce) {
        const r = scene.getBoundingClientRect();
        const total = r.height - window.innerHeight;
        p = total <= 0 ? 0 : Math.min(1, Math.max(0, -r.top / total));
      }

      draw(Math.min(frameCount - 1, Math.floor(p * frameCount)));

      let next = 0;
      beats.forEach((b, i) => {
        if (p >= b.at) next = i;
      });
      setActive((cur) => (cur === next ? cur : next));
    };

    const onScroll = () => {
      if (!rafRef.current) rafRef.current = requestAnimationFrame(tick);
    };

    addEventListener("scroll", onScroll, { passive: true });
    // ResizeObserver, а не resize: он ловит и случай, когда на старте вьюпорт
    // ещё нулевой — иначе холст навсегда остался бы 0×0.
    const ro = new ResizeObserver(() => {
      fit();
      tick();
    });
    ro.observe(document.documentElement);
    tick();

    return () => {
      removeEventListener("scroll", onScroll);
      ro.disconnect();
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    };
  }, [loaded, reduce, frameCount, beats, draw, fit]);

  const pct = frameCount ? Math.round((ready / frameCount) * 100) : 0;

  return (
    <section
      ref={sceneRef}
      className={cn("relative motion-reduce:!h-auto", className)}
      style={{ height: `${scrollVh}vh` }}
      aria-label={alt}
    >
      <div className="sticky top-0 h-dvh overflow-hidden motion-reduce:static motion-reduce:h-auto">
        <canvas
          ref={canvasRef}
          aria-hidden
          className="absolute inset-0 h-full w-full motion-reduce:relative motion-reduce:aspect-video motion-reduce:h-auto"
        />

        {/* Скрим — иначе копирайт не читается поверх живого кадра. Слева на
            десктопе, снизу на мобиле: туда же уходит и текст. */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-[linear-gradient(90deg,rgb(11_14_26/0.88)_0%,rgb(11_14_26/0.55)_42%,transparent_68%)] max-md:bg-[linear-gradient(0deg,rgb(11_14_26/0.92)_0%,rgb(11_14_26/0.6)_42%,transparent_78%)] motion-reduce:hidden"
        />

        {/* Биты — обычный текст в потоке. Смысл секции несут они, а не кадр. */}
        <div className="absolute top-1/2 left-[6vw] z-10 max-w-[min(30rem,42vw)] -translate-y-1/2 max-md:inset-x-5 max-md:top-auto max-md:bottom-8 max-md:max-w-none max-md:translate-y-0 motion-reduce:static motion-reduce:mt-8 motion-reduce:max-w-none motion-reduce:translate-y-0 motion-reduce:px-5">
          {beats.map((b, i) => (
            <div
              key={b.title}
              className={cn(
                "transition-opacity duration-300 ease-[var(--ease-soft)]",
                // Только активный бит в потоке — остальные лежат поверх и погашены.
                i === active ? "relative opacity-100" : "absolute inset-0 opacity-0",
                "max-md:relative max-md:inset-auto",
                "motion-reduce:relative motion-reduce:inset-auto motion-reduce:opacity-100 motion-reduce:not-first:mt-7",
              )}
            >
              <p className="text-[13px] font-bold tracking-[0.18em] text-fire uppercase">
                {b.eyebrow}
              </p>
              <h2 className="display mt-3.5 text-[clamp(26px,3.4vw,44px)] text-white">
                {b.title}
              </h2>
              <p className="mt-3.5 max-w-[34ch] text-[clamp(14px,1.2vw,17px)] leading-relaxed text-slate-300">
                {b.body}
              </p>
            </div>
          ))}
        </div>

        {/* Индикатор — человек должен видеть, что секция кончится */}
        <div
          aria-hidden
          className="absolute bottom-[6vh] left-[6vw] z-20 h-[3px] w-[min(18rem,30vw)] overflow-hidden rounded-full bg-white/15 max-md:inset-x-5 max-md:bottom-3 max-md:w-auto motion-reduce:hidden"
        >
          <span
            className="block h-full rounded-full bg-brand-gradient transition-[width] duration-75"
            style={{ width: `${(active / Math.max(1, beats.length - 1)) * 100}%` }}
          />
        </div>

        {/* Заставка. Пока кадров нет — секция не мигает пустым холстом. */}
        <div
          className={cn(
            "absolute inset-0 z-30 grid place-items-center bg-[#0b0e1a] transition-opacity duration-400",
            loaded ? "pointer-events-none opacity-0" : "opacity-100",
            "motion-reduce:hidden",
          )}
          aria-hidden
        >
          <span className="nums text-[13px] text-slate-400">{near ? `${pct}%` : ""}</span>
        </div>
      </div>
    </section>
  );
}
