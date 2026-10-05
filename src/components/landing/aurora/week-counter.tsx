"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./bento.module.css";

/**
 * Итог недели: числа досчитываются, когда плитка попадает в кадр.
 *
 * Сервер отдаёт финальные значения, а не нули: до гидратации, без JavaScript и для
 * краулера на странице стоит правда («4 из 5 слотов», «80%»), а не заготовка.
 * Отсчёт начинается только при первом попадании в окно и только если движение
 * разрешено — при `prefers-reduced-motion` числа просто стоят на месте.
 *
 * Полоса заполнения остаётся на CSS (scroll-driven), поэтому итог читается даже
 * там, где этот компонент не выполнится.
 */
export function WeekCounter({
  filled,
  total,
  percent,
}: {
  filled: number;
  total: number;
  percent: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const frame = useRef(0);
  const started = useRef(false);
  // Начальное состояние — конечное: это и есть серверная разметка.
  const [shown, setShown] = useState({ filled, percent });

  useEffect(() => {
    const node = ref.current;
    if (!node || started.current) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (started.current || !entries.some((entry) => entry.isIntersecting)) return;
        started.current = true;
        observer.disconnect();

        const duration = 900;
        const start = performance.now();
        const tick = (now: number) => {
          const t = Math.min(1, (now - start) / duration);
          // Кубическое затухание: быстрый разгон, мягкая остановка на числе.
          const eased = 1 - Math.pow(1 - t, 3);
          setShown({ filled: Math.round(filled * eased), percent: Math.round(percent * eased) });
          if (t < 1) frame.current = requestAnimationFrame(tick);
        };
        frame.current = requestAnimationFrame(tick);
      },
      { threshold: 0.4 },
    );

    observer.observe(node);
    return () => {
      observer.disconnect();
      if (frame.current) cancelAnimationFrame(frame.current);
    };
  }, [filled, percent]);

  return (
    <div className={styles.planFoot} ref={ref}>
      <span>
        {shown.filled} из {total} слотов
      </span>
      <b>{shown.percent}%</b>
    </div>
  );
}
