"use client";

// Первый экран «Воздушная Аврора».
// Светлая композиция сохраняет узнаваемый синий язык продукта, а многослойная
// CSS-волна создаёт глубину без изображений, canvas и тяжёлого WebGL.

import Link from "next/link";
import { motion, useReducedMotion } from "motion/react";
import { ArrowRight, Check, PlayCircle } from "lucide-react";
import { Logo } from "@/components/brand";
import { AirWave } from "@/components/landing/air-wave";
import { buttonClassName } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const EASE = [0.22, 1, 0.36, 1] as const;

const TRUST_SIGNALS = [
  "Ручное подтверждение",
  "Telegram и VK",
  "Пауза в любой момент",
] as const;

function HeroLink({
  href,
  children,
  primary = false,
  className,
}: {
  href: string;
  children: React.ReactNode;
  primary?: boolean;
  className?: string;
}) {
  return (
    <Link
      href={href}
      className={cn(
        buttonClassName({ variant: primary ? "brand" : "outline", size: "xl" }),
        "group w-full sm:w-auto",
        primary ? "hover:shadow-[var(--shadow-brand-lg)]" : "bg-white/82 backdrop-blur-xl",
        className,
      )}
    >
      {children}
    </Link>
  );
}

export function Hero() {
  const reduce = useReducedMotion();

  const rise = (delay: number, distance = 18) => ({
    initial: reduce ? false : { opacity: 0, y: distance },
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.65, delay: reduce ? 0 : delay, ease: EASE },
  });

  return (
    <section className="relative isolate flex min-h-[100svh] items-center overflow-hidden bg-white pt-24 pb-18 sm:pt-28 sm:pb-24 lg:pt-30 lg:pb-20">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_12%_18%,rgb(219_234_254_/_0.7),transparent_28%),linear-gradient(180deg,#ffffff_0%,#fbfdff_58%,#f5f9ff_100%)]"
      />
      <AirWave />

      <div className="relative z-10 mx-auto flex w-full max-w-[1180px] items-center px-5 sm:px-8">
        <div className="flex min-w-0 max-w-[760px] flex-col items-start">
          <motion.div {...rise(0)} className="flex items-center gap-4 sm:gap-5">
            <span className="air-logo-shell flex h-[68px] w-[68px] shrink-0 items-center justify-center rounded-[22px] sm:h-[76px] sm:w-[76px] sm:rounded-[24px]">
              <Logo size={58} decorative className="h-[58px] w-[58px] sm:h-16 sm:w-16" />
            </span>
            <span className="text-[clamp(2.25rem,5.4vw,4.25rem)] leading-none font-extrabold tracking-[-0.055em] text-text">
              Аврора
            </span>
          </motion.div>

          <motion.p
            {...rise(0.08)}
            className="mt-7 text-[13px] font-bold tracking-[0.12em] text-brand uppercase sm:text-[14px]"
          >
            SMM-платформа для юридического бизнеса
          </motion.p>

          <h1 className="display mt-4 max-w-[720px] text-[clamp(2.75rem,6.6vw,5.8rem)] text-text text-balance">
            <motion.span {...rise(0.14)} className="block">
              Контент выходит
            </motion.span>
            <motion.span {...rise(0.2)} className="block text-gradient pb-[0.08em]">
              вовремя.
            </motion.span>
          </h1>

          <motion.p
            {...rise(0.3)}
            className="mt-5 max-w-[610px] text-[17px] leading-[1.6] text-text-2 text-pretty sm:text-[19px]"
          >
            Аврора находит сильные темы, пишет в твоём голосе, проверяет факты и
            публикует по расписанию. Ты сохраняешь контроль на каждом шаге.
          </motion.p>

          <motion.div
            {...rise(0.38)}
            className="mt-8 flex w-full flex-col gap-3 sm:w-auto sm:flex-row sm:items-center"
          >
            <HeroLink href="/register" primary>
              Запустить первый цикл
              <ArrowRight
                className="h-5 w-5 transition-transform duration-200 group-hover:translate-x-0.5 motion-reduce:transform-none"
                strokeWidth={2}
                aria-hidden="true"
              />
            </HeroLink>
            <HeroLink href="#how">
              <PlayCircle className="h-5 w-5 text-brand" strokeWidth={1.8} aria-hidden="true" />
              Посмотреть работу Авроры
            </HeroLink>
          </motion.div>

          <motion.ul
            {...rise(0.46)}
            className="mt-6 flex max-w-[620px] flex-wrap gap-x-5 gap-y-2.5 text-[13px] font-semibold text-text-2 sm:text-[14px]"
          >
            {TRUST_SIGNALS.map((signal) => (
              <li key={signal} className="flex items-center gap-2">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-info-soft text-info-text">
                  <Check className="h-3 w-3" strokeWidth={2.6} aria-hidden="true" />
                </span>
                {signal}
              </li>
            ))}
          </motion.ul>
        </div>
      </div>
    </section>
  );
}
