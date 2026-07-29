"use client";

// Секция 6 ТЗ 8.1 — «Финальный призыв» + футер.
// Финальный аккорд лендинга: фон снова яркий (ТЗ 7.1 — яркость в моменты ценности).
// До готовности платформы кнопка регистрации работает как заявка в лист ожидания (ТЗ 8):
// одно поле, один клик, честный срок запуска. Счётчик очереди виден владельцу (ТЗ 8.2).

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion, useReducedMotion, type Variants } from "motion/react";
import { ArrowRight, Send, Sparkles } from "lucide-react";
import { AuroraBackground } from "@/components/aurora-background";
import { Wordmark } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { Badge, Divider, Field, GlassCard, Input } from "@/components/ui/primitives";
import { useStore } from "@/lib/store";
import { ERR_SHAPE, validateContact } from "@/lib/leads";

/* --------------------------------------------------------------- АНИМАЦИЯ */

const EASE = [0.22, 1, 0.36, 1] as const;
const VIEWPORT = { once: true, margin: "-80px" } as const;

// Уважение к prefers-reduced-motion (ТЗ 7.4) сделано через ДЛИТЕЛЬНОСТЬ, а не через цель:
// стартовое состояние одинаково на сервере и на клиенте, поэтому гидрация сходится
// (useReducedMotion на сервере всегда null). При выключенной анимации движение просто мгновенное.
function reveal(y: number, duration: number): Variants {
  return {
    hidden: { opacity: 0, y },
    show: { opacity: 1, y: 0, transition: { duration, ease: EASE } },
  };
}

/* --------------------------------------------------------------- КОНФЕТТИ */
// Момент ценности (ТЗ 13.3: «успех → конфетти»). Уважает «меньше движения».

const CONFETTI_COLORS = ["#6366F1", "#8B5CF6", "#10B981", "#F59E0B"];

function Confetti() {
  // Детерминированный веер частиц: угол по индексу + псевдоразброс дистанции/поворота.
  // Без Math.random — чтобы рендер оставался чистым (правило react-hooks/purity).
  const parts = useMemo(
    () =>
      Array.from({ length: 20 }, (_, i) => {
        const angle = ((-90 + (i / 19) * 180) * Math.PI) / 180; // веер вверх от −90° до +90°
        const dist = 95 + ((i * 37) % 70);
        return {
          id: i,
          x: Math.cos(angle) * dist,
          y: Math.sin(angle) * dist - 40, // общий импульс вверх
          rot: ((i * 53) % 400) - 200,
          color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
          delay: (i % 5) * 0.02,
        };
      }),
    [],
  );

  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center"
    >
      {parts.map((p) => (
        <motion.span
          key={p.id}
          initial={{ opacity: 1, x: 0, y: 0, scale: 0.5, rotate: 0 }}
          animate={{ opacity: 0, x: p.x, y: p.y, scale: 1, rotate: p.rot }}
          transition={{ duration: 0.9, ease: EASE, delay: p.delay }}
          className="absolute h-2 w-2 rounded-[2px]"
          style={{ background: p.color }}
        />
      ))}
    </div>
  );
}

/* -------------------------------------------------------- ФИНАЛЬНЫЙ ПРИЗЫВ */

const HEADLINE = ["Бесплатно.", "Без карты.", "Из России."] as const;


// Запасной путь, если сервер не ответил (ТЗ 13.3) — ведёт к нашему боту.
const SUPPORT_TG = "https://t.me/kontenfkv_bot";

export function FinalCta() {
  const s = useStore();
  const reduce = useReducedMotion();
  const inputRef = useRef<HTMLInputElement>(null);

  const [contact, setContact] = useState("");
  const [honeypot, setHoneypot] = useState(""); // ловушка для ботов — люди не заполняют
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [serverDown, setServerDown] = useState(false);

  // Заголовок оживает построчно — три предложения, три такта (ТЗ 7.4, уровень 2)
  const vWrap = useMemo<Variants>(
    () => ({
      hidden: {},
      show: {
        transition: { staggerChildren: reduce ? 0 : 0.09, delayChildren: reduce ? 0 : 0.05 },
      },
    }),
    [reduce],
  );
  const vLine = useMemo(() => reveal(28, reduce ? 0 : 0.55), [reduce]);
  const vFade = useMemo(() => reveal(16, reduce ? 0 : 0.5), [reduce]);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (loading) return;

    // Быстрая проверка на форме — тот же разбор, что и на сервере (@/lib/leads).
    const problem = validateContact(contact);
    if (problem) {
      setError(problem);
      inputRef.current?.focus();
      return;
    }

    setError(undefined);
    setServerDown(false);
    setLoading(true);

    try {
      // Настоящая заявка (Д.1): пишется в базу + прилетает владельцу в бота.
      const res = await fetch("/api/lead", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contact: contact.trim(),
          // Какая именно кнопка сработала (роль cta_id): заявок теперь может быть несколько
          // источников, и без метки нельзя понять, что конвертит.
          source: "final_waitlist_vk",
          website: honeypot, // honeypot: у людей пусто
        }),
      });
      const data = (await res.json().catch(() => null)) as
        | { ok: boolean; duplicate?: boolean; error?: string }
        | null;

      if (res.ok && data?.ok) {
        // Оптимистично двигаем счётчик очереди; источник правды — база.
        s.joinWaitlist(contact.trim());
        s.toast(
          data.duplicate
            ? { kind: "success", title: "Ты уже в списке", body: "Помним твой контакт — позовём, как откроем." }
            : { kind: "success", title: "Ты в списке", body: "Напишем первым, как только откроем доступ." },
        );
        setDone(true);
      } else if (res.status === 422 || data?.error === "not_contact") {
        // Сервер не признал контакт (клиент обычно ловит раньше — это подстраховка).
        setError(ERR_SHAPE);
        inputRef.current?.focus();
      } else {
        // База/сервер недоступны — заявку не приняли, показываем запасной путь.
        setServerDown(true);
      }
    } catch {
      // Сети нет или функция не ответила — тот же честный запасной путь.
      setServerDown(true);
    } finally {
      setLoading(false);
    }
  }

  return (
    <section
      id="cta"
      aria-labelledby="cta-title"
      className="relative isolate overflow-hidden bg-bg py-24 sm:py-32"
    >
      {/* Финальный аккорд — аврора на полной яркости */}
      <AuroraBackground intensity="hero" grid grain />

      <div className="relative mx-auto w-full max-w-2xl px-5">
        <GlassCard strong className="p-8 text-center sm:p-12">
          <motion.div initial="hidden" whileInView="show" viewport={VIEWPORT} variants={vFade}>
            <Badge tone="brand">Ранний доступ открыт</Badge>
          </motion.div>

          {/* Три предложения — три строки. Последнее забирает градиент. */}
          <motion.h2
            id="cta-title"
            initial="hidden"
            whileInView="show"
            viewport={VIEWPORT}
            variants={vWrap}
            className="display mt-6 text-[clamp(2.4rem,6vw,4.8rem)] text-text"
          >
            {HEADLINE.map((line, i) => (
              <motion.span key={line} variants={vLine} className="block">
                <span className={i === HEADLINE.length - 1 ? "text-gradient" : undefined}>
                  {line}
                </span>
              </motion.span>
            ))}
          </motion.h2>

          <motion.p
            initial="hidden"
            whileInView="show"
            viewport={VIEWPORT}
            variants={vFade}
            className="mx-auto mt-7 max-w-md text-[16px] leading-relaxed text-text-2"
          >
            Платформа уже работает. Подключи Telegram-канал и запланируй первый пост — это
            меньше пяти минут.
          </motion.p>

          {/* ГЛАВНОЕ ДЕЙСТВИЕ. Продукт собран и открыт — значит, финал страницы ведёт в него,
              а не в очередь. Единственный градиент на секции (ТЗ 7.2). */}
          <motion.div
            initial="hidden"
            whileInView="show"
            viewport={VIEWPORT}
            variants={vFade}
            className="mt-9"
          >
            <Link href="/register" data-cta-inline className="block rounded-md">
              <Button variant="brand" size="xl" tabIndex={-1} className="glow-pulse group w-full">
                Забрать ранний доступ
                <ArrowRight
                  className="h-5 w-5 transition-transform duration-200 ease-[var(--ease-soft)] group-hover:translate-x-0.5"
                  strokeWidth={2}
                  aria-hidden
                />
              </Button>
            </Link>

            {/* Честный состав раннего доступа (ТЗ 6). Обе сети уже публикуют. */}
            <p className="mx-auto mt-4 max-w-md text-[13px] leading-relaxed text-text-2">
              Telegram и VK уже работают: разведка, ИИ и автопилот — внутри.
            </p>
          </motion.div>

          {/* ЗАПАСНОЙ ПУТЬ. Продукт бесплатный и открыт — форма для тех, кому проще
              оставить контакт и получить помощь с подключением, а не разбираться самому. */}
          <motion.div
            initial="hidden"
            whileInView="show"
            viewport={VIEWPORT}
            variants={vFade}
            className="mt-9"
          >
            <Divider className="mb-7" />

            <p className="text-[15px] leading-relaxed font-semibold text-text">
              Хочешь попробовать?
            </p>
            <p id="cta-waitlist-why" className="mx-auto mt-1.5 max-w-md text-[14px] leading-relaxed text-text-2">
              Оставь контакт — напишем и поможем подключить канал или сообщество. Одно письмо, без спама.
            </p>

            <form onSubmit={handleSubmit} noValidate className="mt-5 text-left">
              {/* Одно поле: почта ИЛИ ник. Меньше нельзя — больше не нужно. */}
              <Field label="Почта или Telegram" htmlFor="contact" error={error}>
                <Input
                  ref={inputRef}
                  id="contact"
                  name="contact"
                  type="text"
                  inputMode="email"
                  autoComplete="email"
                  placeholder="ты@почта.рф или @ник"
                  value={contact}
                  disabled={loading || done}
                  aria-invalid={error ? true : undefined}
                  aria-describedby="cta-waitlist-why"
                  onChange={(e) => {
                    const next = e.target.value;
                    setContact(next);
                    // Ошибка гаснет сама, как только ввод стал похож на правду
                    if (error && !validateContact(next)) setError(undefined);
                  }}
                  onBlur={() => setError(validateContact(contact))}
                />
              </Field>

              {/* Honeypot: скрыт от людей, видят только боты. Заполнили → заявка тихо отбрасывается. */}
              <div className="pointer-events-none absolute -left-[9999px] top-0 h-0 w-0 overflow-hidden opacity-0">
                <label htmlFor="website">Оставь это поле пустым</label>
                <input
                  id="website"
                  name="website"
                  type="text"
                  tabIndex={-1}
                  autoComplete="off"
                  aria-hidden
                  value={honeypot}
                  onChange={(e) => setHoneypot(e.target.value)}
                />
              </div>

              <div className="relative mt-5">
                <AnimatePresence mode="wait" initial={false}>
                  {done ? (
                    <motion.div
                      key="done"
                      initial={{ opacity: 0, scale: 0.9 }}
                      animate={{ opacity: 1, scale: 1 }}
                      transition={{ duration: reduce ? 0 : 0.4, ease: [0.34, 1.56, 0.64, 1] }}
                      className="relative"
                    >
                      {!reduce && <Confetti />}
                      {/* Успех красим успехом, а не градиентом: магнит на секции уже занят
                          кнопкой раннего доступа, а двух магнитов быть не может (ТЗ 7.2). */}
                      <div
                        role="status"
                        className="flex h-[52px] w-full items-center justify-center gap-2 rounded-sm bg-success-soft text-[15px] font-bold text-success-text"
                      >
                        <Sparkles className="h-5 w-5" aria-hidden />
                        Записали — напишем и поможем подключиться
                      </div>
                    </motion.div>
                  ) : (
                    <motion.div
                      key="submit"
                      initial={false}
                      exit={{ opacity: 0, scale: 0.97 }}
                      transition={{ duration: reduce ? 0 : 0.2, ease: EASE }}
                    >
                      {/* Вторичное действие — тёмная кнопка. Градиент здесь стоял бы вторым
                          магнитом и спорил с «Забрать ранний доступ» (ТЗ 7.2). */}
                      <Button type="submit" variant="solid" size="lg" loading={loading} className="w-full">
                        Хочу подключить
                      </Button>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </form>

            {/* Сервер не ответил — честный запасной путь (ТЗ 13.3, тон 7.5) */}
            <AnimatePresence>
              {serverDown && !done && (
                <motion.div
                  key="down"
                  initial={{ opacity: 0, y: -6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: reduce ? 0 : 0.3, ease: EASE }}
                  className="mt-4 rounded-md bg-danger-soft p-4 text-left"
                >
                  <p className="text-[14px] font-semibold text-danger-text">
                    Сервер не ответил — заявку пока не приняли.
                  </p>
                  <p className="mt-1 text-[13px] leading-relaxed text-text-2">
                    Ничего страшного: напиши нам в Telegram, позовём вручную.
                  </p>
                  <a
                    href={SUPPORT_TG}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-3 inline-flex items-center gap-2 rounded-xs bg-text px-4 py-2.5 text-[14px] font-semibold text-bg transition-opacity duration-200 hover:opacity-90"
                  >
                    <Send className="h-4 w-4" aria-hidden />
                    Написать в Telegram
                  </a>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Успех — одно обещание. Звать в продукт второй раз не нужно: кнопка стоит выше. */}
            <AnimatePresence>
              {done && (
                <motion.div
                  key="after"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: reduce ? 0 : 0.4, ease: EASE, delay: reduce ? 0 : 0.15 }}
                  className="mt-4"
                >
                  <p className="text-[13px] leading-relaxed text-text-2">
                    Не шлём спам и не продаём контакты. Одно письмо — поможем подключить канал
                    или сообщество. Telegram и VK уже работают — кнопкой выше.
                  </p>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        </GlassCard>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ ФУТЕР */

// Рабочие якоря — на секции лендинга. Остальное появится вместе с платформой.
const PRODUCT: { label: string; href: string }[] = [
  { label: "Как это работает", href: "#how" },
  { label: "Цикл", href: "#cycle" },
  { label: "Сравнение", href: "#compare" },
];

const COMPANY = ["О нас", "Блог", "Контакты"];
const LEGAL = ["Политика данных", "Условия"];

function FooterCol({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[13px] font-semibold text-text">{title}</p>
      <ul className="mt-3.5 space-y-2.5">{children}</ul>
    </div>
  );
}

export function Footer() {
  return (
    <footer className="bg-bg-section">
      <Divider />

      <div className="mx-auto w-full max-w-6xl px-5 py-12 sm:px-8">
        <div className="flex flex-col gap-10 md:flex-row md:justify-between md:gap-16">
          {/* Знак и одна строка о продукте */}
          <div className="max-w-xs">
            <Wordmark />
            <p className="mt-4 text-[13px] leading-relaxed text-text-2">
              Сервис автопостинга с разведкой конкурентов. Telegram сейчас, VK — следующей
              волной. Сделано в России.
            </p>
          </div>

          <nav
            aria-label="Разделы сайта"
            className="grid grid-cols-2 gap-x-10 gap-y-8 sm:grid-cols-3 sm:gap-x-14"
          >
            <FooterCol title="Продукт">
              {PRODUCT.map((l) => (
                <li key={l.href}>
                  <a
                    href={l.href}
                    className="text-[13px] text-text-2 transition-colors duration-200 hover:text-text"
                  >
                    {l.label}
                  </a>
                </li>
              ))}
            </FooterCol>

            {/* Пока платформа в разработке — эти страницы честно ещё не написаны */}
            <FooterCol title="Компания">
              {COMPANY.map((l) => (
                <li key={l}>
                  <span className="text-[13px] text-text-3">{l}</span>
                </li>
              ))}
            </FooterCol>

            <FooterCol title="Правовое">
              {LEGAL.map((l) => (
                <li key={l}>
                  <span className="text-[13px] text-text-3">{l}</span>
                </li>
              ))}
            </FooterCol>
          </nav>
        </div>

        <Divider className="my-8" />

        <div className="flex flex-col-reverse items-start gap-5 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-[13px] font-medium text-text-2">© 2026 Аврора</p>
            <p className="mt-1 text-[13px] text-text-3">
              Платформа в разработке. Данные в демо-режиме — вымышленные.
            </p>
          </div>
        </div>
      </div>
    </footer>
  );
}
