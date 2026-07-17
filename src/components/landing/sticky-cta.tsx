"use client";

// Липкая полоса с главным действием — только для узких экранов.
// Зачем: на телефоне между hero и финалом больше 7 000 пикселей скролла, и всё это время
// нажать было некуда. Кнопка в шапке на мобиле спрятана в бургер, то есть её тоже нет.
//
// Правило одного магнита (ТЗ 7.2) держим честно: полоса прячется, как только на экране
// виден любой CTA из потока страницы (они помечены data-cta-inline). Двух градиентов
// одновременно не бывает ни в один момент.

import { useEffect, useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";

export function StickyCta() {
  const reduce = useReducedMotion();

  // Ушёл ли hero за верхнюю кромку
  const [pastHero, setPastHero] = useState(false);
  // Виден ли сейчас какой-нибудь CTA в потоке
  const [inlineCtaVisible, setInlineCtaVisible] = useState(false);

  useEffect(() => {
    const hero = document.querySelector<HTMLElement>("main > section");
    if (!hero) return;
    const io = new IntersectionObserver(([e]) => setPastHero(!e.isIntersecting), {
      threshold: 0,
    });
    io.observe(hero);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    const targets = document.querySelectorAll<HTMLElement>("[data-cta-inline]");
    if (targets.length === 0) return;

    const visible = new Set<Element>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) visible.add(e.target);
          else visible.delete(e.target);
        }
        setInlineCtaVisible(visible.size > 0);
      },
      { threshold: 0 },
    );

    targets.forEach((t) => io.observe(t));
    return () => io.disconnect();
  }, []);

  const show = pastHero && !inlineCtaVisible;

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          initial={reduce ? { opacity: 0 } : { y: "110%" }}
          animate={reduce ? { opacity: 1 } : { y: "0%" }}
          exit={reduce ? { opacity: 0 } : { y: "110%" }}
          transition={{ duration: reduce ? 0.15 : 0.32, ease: [0.22, 1, 0.36, 1] }}
          // pb с запасом под домашнюю полоску iPhone
          className="glass fixed inset-x-0 bottom-0 z-40 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] lg:hidden"
        >
          <Link href="/register" className="block rounded-md">
            <Button variant="brand" size="lg" tabIndex={-1} className="w-full">
              Забрать ранний доступ
              <ArrowRight className="h-4 w-4" strokeWidth={2} aria-hidden />
            </Button>
          </Link>
          <p className="mt-2 text-center text-[13px] leading-tight text-text-2">
            Бесплатно, без карты. Telegram работает сейчас.
          </p>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
