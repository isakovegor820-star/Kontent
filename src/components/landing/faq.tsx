"use client";

// ВОПРОСЫ И ВОЗРАЖЕНИЯ — секция лендинга.
// Прямого пункта в ТЗ 8.1 нет, но раздел 6 требует «продукт объясняет себя»
// и «честность лимитов и сроков — всегда». Здесь мы закрываем возражения
// покупателя ДО регистрации: деньги, закон, безопасность, надёжность, сроки.
// Каждый ответ — правда из ТЗ, без маркетингового тумана.
// Тон — ТЗ 7.5: просто и дружелюбно, на «ты», без жаргона и панибратства.

import { useId, useState } from "react";
import { AnimatePresence, motion, useReducedMotion, type Transition } from "motion/react";
import {
  CalendarClock,
  Globe,
  KeyRound,
  Plus,
  RefreshCw,
  Scale,
  Sparkles,
  Users,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { AuroraBackground } from "@/components/aurora-background";
import { Badge, GlassCard, TelegramIcon } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";

// Тот же кубик, что и в --ease-soft: анимация JS и CSS звучат в один голос.
const EASE = [0.22, 1, 0.36, 1] as const;

type Qa = {
  icon: LucideIcon;
  q: string;
  a: string;
};

const ITEMS: Qa[] = [
  {
    icon: Wallet,
    q: "Правда бесплатно? В чём подвох?",
    a: "Подвоха нет: на старте платформа полностью бесплатна, без карты и пейволов. Мы сначала растим живую аудиторию, монетизацию придумаем потом — и скажем об этом заранее. Единственное ограничение — честный дневной лимит ИИ-генераций, потому что ИИ стоит денег. Лимит виден в интерфейсе, а не спрятан в справке.",
  },
  {
    icon: Scale,
    q: "Это законно — следить за конкурентами?",
    a: "Мы собираем только открытые данные — то, что видит любой подписчик, — и только через официальные API соцсетей. Ничего закрытого, никаких персональных данных, никакого парсинга в обход правил. Это то же, что ты можешь посмотреть руками — просто платформа делает это за тебя и подводит итог.",
  },
  {
    icon: KeyRound,
    q: "Мои токены соцсетей в безопасности?",
    a: "Токены хранятся только в зашифрованном виде. Ни один пост не уйдёт без твоего ведома: пока автопилот на подтверждении, платформа не публикует ничего, что ты не одобрил.",
  },
  {
    icon: RefreshCw,
    q: "А если пост не выйдет?",
    a: "Публикует сервер, а не твой компьютер — можно закрыть ноутбук. Если сеть не ответила, платформа повторит попытку до 3 раз и напишет тебе в бот: что случилось, что мы уже делаем и нужно ли что-то от тебя. Пост не потеряется и не задвоится.",
  },
  {
    icon: Sparkles,
    q: "ИИ будет писать как робот?",
    a: "ИИ учится на твоих постах и на том, что реально зашло у тебя и у конкурентов. Он пишет черновик — ты правишь одной кнопкой или руками. Через две недели одобрений без правок можно включить полное доверие. А можно не включать никогда.",
  },
  {
    icon: Globe,
    q: "А VK? Instagram, TikTok, YouTube?",
    a: "Telegram и VK уже работают: подключаешь канал или сообщество — и сервер публикует сам. Мы начали именно с этих двух сетей, потому что их не поддерживает ни один глобальный сервис, а именно там сидит наша аудитория. Instagram, TikTok и YouTube — позже. Мы лучше сделаем две сети отлично, чем шесть кое-как.",
  },
  {
    icon: CalendarClock,
    q: "Продукт уже работает или это лист ожидания?",
    a: "Работает. Ранний доступ открыт прямо сейчас: подключаешь Telegram-канал или VK-сообщество, добавляешь конкурентов — и разведка, ИИ и автопилот уже внутри. Публикуют обе сети. Даты мы называем только на одну волну вперёд — так честнее, чем обещать всё и сразу.",
  },
  {
    icon: Users,
    q: "Я SMM-агентство, у меня 20 клиентов.",
    a: "Соло-режим включён по умолчанию, чтобы не мешать одиночкам. Командный режим — роли, согласования, комментарии — включается одной настройкой. Все клиенты в одном месте, отчёты собираются сами.",
  },
];

export function Faq() {
  // Первым открыт вопрос про деньги: человек читает главный ответ,
  // не сделав ни одного клика. −1 — все закрыты.
  const [openIdx, setOpenIdx] = useState(0);
  const reduced = useReducedMotion();
  const uid = useId();
  const titleId = `${uid}-title`;

  // При prefers-reduced-motion длительности обнуляются: состояние меняется,
  // движения нет (ТЗ 7.4).
  const panelTransition: Transition = { duration: reduced ? 0 : 0.28, ease: EASE };

  return (
    <section
      id="faq"
      aria-labelledby={titleId}
      className="relative isolate overflow-hidden bg-bg-section py-24 sm:py-32"
    >
      <AuroraBackground intensity="section" grid={false} grain />

      <div className="relative mx-auto grid w-full max-w-6xl gap-12 px-5 sm:px-8 lg:grid-cols-[minmax(0,0.82fr)_minmax(0,1.18fr)] lg:gap-16">
        {/* ------------------------------------------------ ЛЕВО: заголовок */}
        <motion.div
          initial={{ opacity: 0, y: reduced ? 0 : 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ duration: reduced ? 0 : 0.5, ease: EASE }}
          className="lg:sticky lg:top-28 lg:self-start"
        >
          <Badge tone="brand">Без увиливаний</Badge>

          <h2
            id={titleId}
            className="display mt-5 text-[clamp(2.15rem,4.6vw,3.4rem)] text-text"
          >
            Вопросы, которые ты всё равно задашь
          </h2>

          <p className="mt-6 max-w-md text-[16px] leading-relaxed text-text-2">
            Отвечаем здесь и сразу — до регистрации, до почты, до любых кнопок. Чтобы не пришлось
            искать подвох между строк.
          </p>

          {/* Живой человек на том конце — обещание из ТЗ 7.5 */}
          <GlassCard className="mt-8 flex max-w-md items-start gap-3.5 p-5">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xs bg-info-soft text-info-text">
              <TelegramIcon className="h-5 w-5" />
            </span>
            <p className="text-[14px] leading-relaxed text-text-2">
              <span className="font-semibold text-text">Не нашёл ответа?</span> Напиши в Telegram —
              отвечаем сами, без поддержки-робота.
            </p>
          </GlassCard>
        </motion.div>

        {/* --------------------------------------------- ПРАВО: аккордеон */}
        <GlassCard strong className="overflow-hidden rounded-xl p-0">
          <ul className="divide-y divide-line">
            {ITEMS.map((item, i) => {
              const open = openIdx === i;
              const btnId = `${uid}-q-${i}`;
              const panelId = `${uid}-a-${i}`;
              const Icon = item.icon;

              return (
                <motion.li
                  key={item.q}
                  initial={{ opacity: 0, y: reduced ? 0 : 14 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true, margin: "-60px" }}
                  transition={{
                    duration: reduced ? 0 : 0.45,
                    delay: reduced ? 0 : i * 0.04,
                    ease: EASE,
                  }}
                  className="relative"
                >
                  {/* Единственный градиент на секции — рельс раскрытого вопроса.
                      Растёт по scaleY: transform, а не width/height (ТЗ 7.4). */}
                  <span
                    aria-hidden
                    className={cn(
                      "pointer-events-none absolute top-0 bottom-0 left-0 w-[3px] origin-top bg-brand-gradient",
                      "transition-transform duration-300 ease-[var(--ease-soft)]",
                      open ? "scale-y-100" : "scale-y-0",
                    )}
                  />

                  <h3>
                    <button
                      type="button"
                      id={btnId}
                      aria-expanded={open}
                      aria-controls={panelId}
                      onClick={() => setOpenIdx(open ? -1 : i)}
                      className={cn(
                        "group flex w-full cursor-pointer items-center gap-4 px-5 py-5 text-left",
                        "transition-colors duration-200 sm:gap-5 sm:px-7 sm:py-6",
                        open ? "bg-surface-inset/40" : "hover:bg-surface-inset/40",
                      )}
                    >
                      <span
                        className={cn(
                          "flex h-10 w-10 shrink-0 items-center justify-center rounded-xs",
                          "transition-colors duration-200",
                          open
                            ? "bg-info-soft text-info-text"
                            : "bg-surface-inset text-text-3 group-hover:text-text-2",
                        )}
                      >
                        <Icon className="h-[18px] w-[18px]" strokeWidth={1.75} aria-hidden />
                      </span>

                      <span
                        className={cn(
                          "flex-1 text-[16px] leading-snug font-bold -tracking-[0.01em] text-text",
                          "transition-colors duration-200 sm:text-[17px]",
                          !open && "group-hover:text-brand",
                        )}
                      >
                        {item.q}
                      </span>

                      {/* Плюс превращается в крестик поворотом на 45° */}
                      <span
                        className={cn(
                          "flex h-9 w-9 shrink-0 items-center justify-center rounded-full border",
                          "transition-all duration-200 ease-[var(--ease-spring)]",
                          open
                            ? "rotate-45 border-brand/30 bg-info-soft text-brand"
                            : "border-line text-text-3 group-hover:border-line-strong group-hover:text-text-2",
                        )}
                      >
                        <Plus className="h-[18px] w-[18px]" strokeWidth={2} aria-hidden />
                      </span>
                    </button>
                  </h3>

                  <AnimatePresence initial={false}>
                    {open && (
                      <motion.div
                        key="panel"
                        id={panelId}
                        role="region"
                        aria-labelledby={btnId}
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={panelTransition}
                        className="overflow-hidden"
                      >
                        {/* На телефоне ответ во всю ширину — читать важнее, чем ровнять по иконке */}
                        <p className="max-w-[64ch] px-5 pb-6 text-[15px] leading-relaxed text-text-2 sm:pr-8 sm:pb-7 sm:pl-[88px] sm:text-[16px]">
                          {item.a}
                        </p>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </motion.li>
              );
            })}
          </ul>
        </GlassCard>
      </div>
    </section>
  );
}
