"use client";

import { useId, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  AlertTriangle,
  ArrowRight,
  BookOpen,
  Check,
  Database,
  FileText,
  MessageSquareText,
  RefreshCw,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { AuroraBackground } from "@/components/aurora-background";
import { Badge, GlassCard } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const EASE = [0.22, 1, 0.36, 1] as const;

const SOURCES = [
  {
    id: "brief",
    label: "Бриф",
    meta: "12 фактов",
    icon: FileText,
    fact: "Помогаем предпринимателям проходить налоговые проверки и споры.",
    use: "Определяет, что можно утверждать от лица автора.",
  },
  {
    id: "materials",
    label: "Материалы",
    meta: "8 документов",
    icon: Database,
    fact: "Срок ответа на требование начинается со следующего рабочего дня.",
    use: "Даёт проверяемую опору для конкретного материала.",
  },
  {
    id: "archive",
    label: "Архив постов",
    meta: "46 публикаций",
    icon: MessageSquareText,
    fact: "Без паники и канцелярита: сначала срок, потом документы, затем действие.",
    use: "Учит ритму и тону, но не подменяет факты.",
  },
] as const;

export function ChannelMemory() {
  const reduced = useReducedMotion();
  const titleId = useId();
  const [activeId, setActiveId] = useState<(typeof SOURCES)[number]["id"]>("brief");
  const source = SOURCES.find((item) => item.id === activeId) ?? SOURCES[0];

  return (
    <section
      id="memory"
      aria-labelledby={titleId}
      className="relative isolate overflow-hidden bg-bg py-24 sm:py-32"
    >
      <AuroraBackground intensity="section" grid />

      <div className="relative mx-auto max-w-6xl px-5 sm:px-8">
        <motion.header
          initial={reduced ? false : { opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ duration: 0.5, ease: EASE }}
          className="max-w-3xl"
        >
          <Badge tone="brand">
            <BookOpen className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
            Память канала
          </Badge>
          <h2
            id={titleId}
            className="display mt-5 text-[38px] text-text sm:text-[46px] lg:text-[52px]"
          >
            Пишет в твоём голосе. <span className="text-gradient">Факты не выдумывает.</span>
          </h2>
          <p className="mt-5 max-w-2xl text-[16px] leading-relaxed text-text-2">
            Аврора разделяет знания и подачу: факты берёт из твоих материалов, а ритм и тон —
            из опубликованных постов. Если подтверждения нет, конкретика не попадёт в текст.
          </p>
        </motion.header>

        <div className="mt-12 grid gap-6 lg:grid-cols-[0.82fr_1.18fr] lg:gap-8">
          <motion.div
            initial={reduced ? false : { opacity: 0, x: -24 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true, margin: "-80px" }}
            transition={{ duration: 0.55, ease: EASE }}
          >
            <GlassCard strong className="h-full p-4 sm:p-5">
              <p className="px-2 text-[13px] font-semibold text-text-2">Три источника памяти</p>
              <div className="mt-3 space-y-2" role="tablist" aria-label="Источники памяти канала">
                {SOURCES.map((item) => {
                  const Icon = item.icon;
                  const active = item.id === activeId;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      aria-controls={`${titleId}-${item.id}`}
                      onClick={() => setActiveId(item.id)}
                      className={cn(
                        "flex min-h-16 w-full cursor-pointer items-center gap-3 rounded-md px-3 text-left transition-colors duration-200",
                        active ? "bg-info-soft" : "hover:bg-surface-inset",
                      )}
                    >
                      <span
                        className={cn(
                          "flex h-10 w-10 shrink-0 items-center justify-center rounded-xs",
                          active ? "bg-surface text-brand shadow-soft" : "bg-surface-inset text-text-3",
                        )}
                      >
                        <Icon className="h-5 w-5" strokeWidth={1.8} aria-hidden />
                      </span>
                      <span className="min-w-0 flex-1">
                        <strong className="block text-[15px] text-text">{item.label}</strong>
                        <span className="mt-0.5 block text-[13px] text-text-3">{item.meta}</span>
                      </span>
                      <ArrowRight
                        className={cn(
                          "h-4 w-4 shrink-0 transition-transform duration-200",
                          active ? "translate-x-0 text-brand" : "-translate-x-1 text-text-3",
                        )}
                        strokeWidth={2}
                        aria-hidden
                      />
                    </button>
                  );
                })}
              </div>
            </GlassCard>
          </motion.div>

          <motion.div
            initial={reduced ? false : { opacity: 0, x: 24 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true, margin: "-80px" }}
            transition={{ duration: 0.55, delay: reduced ? 0 : 0.1, ease: EASE }}
          >
            <GlassCard strong className="flex h-full min-h-[420px] flex-col overflow-hidden p-0">
              <div className="flex items-center gap-2 border-b border-line px-5 py-4 text-[13px] font-semibold text-text-2">
                <Sparkles className="h-4 w-4 text-brand" strokeWidth={2} aria-hidden />
                Активная опора для материала
                <span className="ml-auto inline-flex items-center gap-1.5 rounded-full bg-success-soft px-2.5 py-1 text-success-text">
                  <span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden />
                  найдена
                </span>
              </div>

              <div className="flex flex-1 flex-col p-5 sm:p-7">
                <AnimatePresence mode="wait" initial={false}>
                  <motion.div
                    key={source.id}
                    id={`${titleId}-${source.id}`}
                    role="tabpanel"
                    initial={reduced ? false : { opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={reduced ? undefined : { opacity: 0, y: -8 }}
                    transition={{ duration: reduced ? 0 : 0.25, ease: EASE }}
                  >
                    <p className="text-[13px] font-bold uppercase tracking-[0.08em] text-brand">
                      {source.label} · {source.meta}
                    </p>
                    <blockquote className="mt-4 text-[23px] leading-snug font-extrabold -tracking-[0.02em] text-text sm:text-[28px]">
                      «{source.fact}»
                    </blockquote>
                    <p className="mt-4 text-[14px] leading-relaxed text-text-2">{source.use}</p>
                  </motion.div>
                </AnimatePresence>

                <div className="mt-auto rounded-md bg-surface-inset p-4 sm:p-5">
                  <p className="flex items-center gap-2 text-[13px] font-semibold text-text-2">
                    <FileText className="h-4 w-4 text-text-3" strokeWidth={1.8} aria-hidden />
                    Черновик с памятью канала
                  </p>
                  <p className="mt-3 text-[15px] leading-relaxed text-text">
                    Без паники и канцелярита: разберём требование, сроки и документы по шагам —
                    только на фактах из твоих материалов.
                  </p>
                  <div className="mt-4 flex flex-wrap gap-2">
                    <span className="rounded-full bg-surface px-2.5 py-1 text-[13px] font-semibold text-success-text shadow-xs">
                      факты подтверждены
                    </span>
                    <span className="rounded-full bg-surface px-2.5 py-1 text-[13px] font-semibold text-info-text shadow-xs">
                      голос совпадает
                    </span>
                  </div>
                </div>
              </div>
            </GlassCard>
          </motion.div>
        </div>
      </div>
    </section>
  );
}

const CHECKS = [
  { label: "Факты", before: "1 фраза без опоры", after: "Подтверждены", problem: true },
  { label: "Голос", before: "Слишком официальный тон", after: "Совпадает", problem: true },
  { label: "Структура", before: "Пройдена", after: "Пройдена", problem: false },
  { label: "Правила канала", before: "Пройдены", after: "Пройдены", problem: false },
] as const;

export function QualityControl() {
  const reduced = useReducedMotion();
  const titleId = useId();
  const [fixed, setFixed] = useState(false);

  return (
    <section
      id="quality"
      aria-labelledby={titleId}
      className="relative isolate overflow-hidden bg-bg-section py-24 sm:py-32"
    >
      <AuroraBackground intensity="section" grid={false} />

      <div className="relative mx-auto grid max-w-6xl items-center gap-12 px-5 sm:px-8 lg:grid-cols-[0.82fr_1.18fr] lg:gap-16">
        <motion.div
          initial={reduced ? false : { opacity: 0, x: -24 }}
          whileInView={{ opacity: 1, x: 0 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ duration: 0.55, ease: EASE }}
        >
          <Badge tone="brand">
            <ShieldCheck className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
            Контроль качества
          </Badge>
          <h2
            id={titleId}
            className="display mt-5 text-[38px] text-text sm:text-[46px] lg:text-[52px]"
          >
            В канал проходит <span className="text-gradient">не каждый текст.</span>
          </h2>
          <p className="mt-5 max-w-xl text-[16px] leading-relaxed text-text-2">
            До расписания Аврора проверяет факты, голос, структуру и правила конкретного канала.
            Ошибки можно исправить автоматически — а последнее слово всё равно остаётся за тобой.
          </p>

          <ul className="mt-8 space-y-3">
            {[
              "Порог качества — 85 из 100",
              "Ручное подтверждение можно оставить навсегда",
              "Очередь ставится на паузу в любой момент",
            ].map((item) => (
              <li key={item} className="flex items-start gap-3 text-[14px] leading-relaxed text-text-2">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-success-soft text-success-text">
                  <Check className="h-3 w-3" strokeWidth={3} aria-hidden />
                </span>
                {item}
              </li>
            ))}
          </ul>
        </motion.div>

        <motion.div
          initial={reduced ? false : { opacity: 0, x: 24 }}
          whileInView={{ opacity: 1, x: 0 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ duration: 0.55, delay: reduced ? 0 : 0.1, ease: EASE }}
        >
          <GlassCard strong className="overflow-hidden p-0">
            <div className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-4">
              <div>
                <p className="text-[13px] font-bold text-text">Материал 0184</p>
                <p className="mt-0.5 text-[13px] text-text-3">Проверка перед расписанием</p>
              </div>
              <span
                className={cn(
                  "ml-auto inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-[13px] font-bold",
                  fixed ? "bg-success-soft text-success-text" : "bg-fire-soft text-fire-text",
                )}
                role="status"
                aria-live="polite"
              >
                {fixed ? (
                  <Check className="h-3.5 w-3.5" strokeWidth={3} aria-hidden />
                ) : (
                  <AlertTriangle className="h-3.5 w-3.5" strokeWidth={2.5} aria-hidden />
                )}
                {fixed ? "Готов к выпуску" : "Нужно исправить"}
              </span>
            </div>

            <div className="grid gap-6 p-5 sm:p-7 md:grid-cols-[0.72fr_1.28fr]">
              <div className="flex flex-col items-center justify-center rounded-md bg-surface-inset p-5 text-center">
                <div className="relative flex h-32 w-32 items-center justify-center rounded-full bg-surface shadow-card">
                  <span
                    aria-hidden
                    className={cn(
                      "absolute inset-2 rounded-full border-[7px] transition-colors duration-300",
                      fixed ? "border-success" : "border-fire",
                    )}
                  />
                  <AnimatePresence mode="wait" initial={false}>
                    <motion.strong
                      key={fixed ? "92" : "72"}
                      initial={reduced ? false : { opacity: 0, scale: 0.8 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={reduced ? undefined : { opacity: 0, scale: 1.08 }}
                      transition={{ duration: reduced ? 0 : 0.25, ease: EASE }}
                      className="nums text-[38px] font-extrabold text-text"
                    >
                      {fixed ? 92 : 72}
                    </motion.strong>
                  </AnimatePresence>
                </div>
                <p className="mt-4 text-[13px] font-semibold text-text-2">Порог публикации: 85</p>
              </div>

              <div>
                <ul className="space-y-2.5">
                  {CHECKS.map((check) => {
                    const passed = fixed || !check.problem;
                    return (
                      <li
                        key={check.label}
                        className="flex min-h-14 items-center gap-3 rounded-sm border border-line bg-surface px-3.5 py-2.5"
                      >
                        <span
                          className={cn(
                            "flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
                            passed ? "bg-success-soft text-success-text" : "bg-fire-soft text-fire-text",
                          )}
                        >
                          {passed ? (
                            <Check className="h-4 w-4" strokeWidth={3} aria-hidden />
                          ) : (
                            <AlertTriangle className="h-4 w-4" strokeWidth={2.3} aria-hidden />
                          )}
                        </span>
                        <span className="min-w-0 flex-1">
                          <strong className="block text-[13px] text-text">{check.label}</strong>
                          <span className="mt-0.5 block text-[13px] text-text-3">
                            {fixed ? check.after : check.before}
                          </span>
                        </span>
                      </li>
                    );
                  })}
                </ul>

                <Button
                  type="button"
                  variant={fixed ? "outline" : "brand"}
                  size="lg"
                  onClick={() => setFixed((value) => !value)}
                  className="mt-4 w-full"
                >
                  {fixed ? (
                    <>
                      <RefreshCw className="h-4 w-4" strokeWidth={2} aria-hidden />
                      Вернуть пример ошибки
                    </>
                  ) : (
                    <>
                      <Sparkles className="h-4 w-4" strokeWidth={2} aria-hidden />
                      Исправить по стандарту
                    </>
                  )}
                </Button>
              </div>
            </div>
          </GlassCard>
        </motion.div>
      </div>
    </section>
  );
}
