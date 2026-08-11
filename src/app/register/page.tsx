"use client";

// ЭКРАН А2 — ВХОД (Д.2). Регистрация и вход по почте и своему паролю. Пароль храним
// только хешем на сервере, сессия — 30 дней в cookie. Ненастроенные Telegram/VK login
// не показываем: единственный CTA ведёт в реально работающий email/password flow.

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion, type Variants } from "motion/react";
import {
  ArrowLeft,
  CalendarCheck,
  Eye,
  EyeOff,
  Flame,
  Radar,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Divider, Field, GlassCard, Input } from "@/components/ui/primitives";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { hasPendingProjectInvite } from "@/lib/project-invite-client";

const EASE = [0.22, 1, 0.36, 1] as const;
const PASSWORD_MIN = 8;

/* ------------------------------------------------------------- ВИТРИНА СПРАВА */

const VALUE: { icon: LucideIcon; tint: string; text: string }[] = [
  { icon: Radar, tint: "text-brand", text: "Досье на конкурентов — с выводами человеческим языком" },
  { icon: Flame, tint: "text-fire", text: "Лента залетающих тем со сценариями" },
  { icon: Sparkles, tint: "text-brand-2", text: "ИИ пишет посты твоим голосом" },
  { icon: CalendarCheck, tint: "text-success", text: "Публикация с сервера — компьютер не нужен" },
];

/* ------------------------------------------------------------------ АНИМАЦИЯ */

const stagger: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.08, delayChildren: 0.2 } },
};
const item: Variants = {
  hidden: { opacity: 0, y: 16 },
  show: { opacity: 1, y: 0, transition: { duration: 0.5, ease: EASE } },
};
const still: Variants = { hidden: { opacity: 1, y: 0 }, show: { opacity: 1, y: 0 } };

/* -------------------------------------------------------------- ВАЛИДАЦИЯ */

function validateEmail(raw: string): string | undefined {
  const value = raw.trim();
  if (!value) return "Введи почту.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) return "Кажется, тут опечатка. Проверь адрес.";
  return undefined;
}

type Mode = "register" | "login";

function signedInDestination() {
  return hasPendingProjectInvite(typeof window === "undefined" ? null : window.sessionStorage)
    ? "/invite"
    : "/app/calendar";
}

/* ------------------------------------------------------------------- ЭКРАН */

export default function RegisterPage() {
  const s = useStore();
  const router = useRouter();
  const reduce = useReducedMotion();
  const emailRef = useRef<HTMLInputElement>(null);
  const pwRef = useRef<HTMLInputElement>(null);
  const modeRefs = useRef<Record<Mode, HTMLButtonElement | null>>({
    register: null,
    login: null,
  });

  const [mode, setMode] = useState<Mode>("register");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [emailErr, setEmailErr] = useState<string>();
  const [pwErr, setPwErr] = useState<string>();
  const [formErr, setFormErr] = useState<string>();
  const [pending, setPending] = useState(false);

  const busy = pending;
  // Уже вошёл (например, вернулся по ссылке) — сразу в платформу, не показываем вход.
  useEffect(() => {
    if (s.authReady && s.user) router.replace(signedInDestination());
  }, [s.authReady, s.user, router]);

  function switchMode(next: Mode) {
    setMode(next);
    setFormErr(undefined);
    setPwErr(undefined);
  }

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;

    const ee = validateEmail(email);
    const pe = !password
      ? "Введи пароль."
      : mode === "register" && password.length < PASSWORD_MIN
        ? `Пароль — минимум ${PASSWORD_MIN} символов.`
        : undefined;
    setEmailErr(ee);
    setPwErr(pe);
    setFormErr(undefined);
    if (ee) {
      emailRef.current?.focus();
      return;
    }
    if (pe) {
      pwRef.current?.focus();
      return;
    }

    setPending(true);
    try {
      const res = await fetch(mode === "register" ? "/api/auth/register" : "/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      const data = (await res.json().catch(() => null)) as {
        ok?: boolean;
        error?: string;
        retryAfter?: number;
        accountCreated?: boolean;
      } | null;

      if (res.ok && data?.ok) {
        await s.refreshAuth();
        s.toast({
          kind: "success",
          title: mode === "register" ? "Аккаунт создан" : "Ты вошёл",
          body: "Осталось пара шагов — и ты в календаре.",
        });
        router.push(signedInDestination());
        return;
      }

      if (res.status === 429 && data?.error === "rate_limited") {
        const mins = Math.max(1, Math.ceil((data.retryAfter ?? 900) / 60));
        setFormErr(`Слишком много попыток. Подожди ${mins} мин — это защита от подбора пароля.`);
      } else if (res.status === 409 && data?.error === "email_taken") {
        setFormErr("Эта почта уже занята. Похоже, у тебя есть аккаунт — войди.");
        setMode("login");
        setPwErr(undefined);
      } else if (res.status === 401 && data?.error === "invalid") {
        setFormErr("Неверная почта или пароль. Проверь и попробуй ещё раз.");
      } else if (res.status === 422 && data?.error === "bad_email") {
        setEmailErr("Кажется, тут опечатка. Проверь адрес.");
      } else if (res.status === 422 && data?.error === "bad_password") {
        setPwErr(`Пароль — минимум ${PASSWORD_MIN} символов.`);
      } else if (res.status === 503 && data?.error === "session_creation_failed" && data.accountCreated) {
        setMode("login");
        setFormErr("Аккаунт создан, но автоматический вход не завершился. Войди с тем же паролем.");
      } else {
        setFormErr("Сервер не ответил. Попробуй ещё раз.");
      }
    } catch {
      setFormErr("Сервер не ответил. Попробуй ещё раз.");
    } finally {
      setPending(false);
    }
  }

  const rise = (delay: number) => ({
    initial: reduce ? false : { opacity: 0, y: 16 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.5, delay: reduce ? 0 : delay, ease: EASE },
  });

  const isReg = mode === "register";

  return (
    <main id="main" className="v3-paper relative flex min-h-dvh items-center overflow-hidden py-12 sm:py-16">
      <div className="relative mx-auto grid w-full max-w-6xl grid-cols-1 items-center gap-16 px-5 sm:px-8 lg:grid-cols-2 lg:gap-16 xl:gap-20">
        {/* ══════════════════════════════════════════════════ ЛЕВО: вход */}
        <div className="mx-auto w-full max-w-md">
          <motion.div {...rise(0)}>
            <Link
              href="/"
              className="group -ml-3 inline-flex h-11 items-center gap-2 rounded-xs px-3 text-[14px] font-semibold text-text-2 transition-colors duration-200 hover:bg-surface-inset hover:text-text"
            >
              <ArrowLeft
                className="h-4 w-4 transition-transform duration-200 ease-[var(--ease-soft)] group-hover:-translate-x-0.5"
                strokeWidth={2}
                aria-hidden
              />
              На главную
            </Link>
          </motion.div>

          <motion.div {...rise(0.06)} className="mt-8">
            {/* Штамп как на лендинге v3: жёлтый квадрат, чернильная рамка */}
            <span className="flex items-center gap-2.5">
              <span
                aria-hidden
                className="flex h-9 w-9 items-center justify-center border-2 border-line bg-[var(--acc)] font-[family-name:var(--v3-display)] text-[17px] font-black shadow-[3px_3px_0_var(--ink)]"
              >
                А
              </span>
              <span className="font-[family-name:var(--v3-display)] text-[16px] font-bold tracking-[0.08em] uppercase">
                Аврора
              </span>
            </span>
          </motion.div>

          <motion.h1 {...rise(0.12)} className="v3-display mt-6 text-3xl font-bold text-text sm:text-4xl">
            {isReg ? "Создай аккаунт" : "С возвращением"}
          </motion.h1>

          <motion.p {...rise(0.18)} className="mt-4 text-[16px] leading-relaxed text-text-2">
            {isReg
              ? "Почта и пароль — этого хватит, чтобы начать. Ни карты, ни анкет."
              : "Введи почту и пароль — и ты внутри, там же, где всё оставил."}
          </motion.p>

          {/* Переключатель Регистрация / Вход */}
          <motion.div
            {...rise(0.24)}
            className="mt-8 grid grid-cols-2 gap-1 rounded-sm bg-surface-inset p-1"
            role="tablist"
            aria-label="Регистрация или вход"
            onKeyDown={(event) => {
              if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
              event.preventDefault();
              const next: Mode =
                event.key === "ArrowLeft" || event.key === "Home" ? "register" : "login";
              switchMode(next);
              modeRefs.current[next]?.focus();
            }}
          >
            {(["register", "login"] as Mode[]).map((m) => (
              <button
                key={m}
                ref={(element) => {
                  modeRefs.current[m] = element;
                }}
                type="button"
                role="tab"
                aria-selected={mode === m}
                tabIndex={mode === m ? 0 : -1}
                onClick={() => switchMode(m)}
                className={cn(
                  "min-h-11 cursor-pointer rounded-xs text-[14px] font-semibold transition-colors duration-200",
                  mode === m ? "bg-surface text-text shadow-sm" : "text-text-3 hover:text-text-2",
                )}
              >
                {m === "register" ? "Регистрация" : "Вход"}
              </button>
            ))}
          </motion.div>

          {/* Форма: почта + пароль */}
          <motion.form
            {...rise(0.3)}
            method="post"
            onSubmit={submit}
            noValidate
            className="mt-5"
          >
            <Field label="Почта" htmlFor="email" error={emailErr}>
              <Input
                ref={emailRef}
                id="email"
                name="email"
                type="email"
                inputMode="email"
                autoComplete="email"
                placeholder="ты@почта.рф"
                value={email}
                disabled={busy}
                aria-invalid={emailErr ? true : undefined}
                onChange={(ev) => {
                  setEmail(ev.target.value);
                  if (emailErr) setEmailErr(undefined);
                  if (formErr) setFormErr(undefined);
                }}
                onBlur={() => {
                  if (email.trim()) setEmailErr(validateEmail(email));
                }}
              />
            </Field>

            <div className="mt-4">
              <Field
                label="Пароль"
                htmlFor="password"
                error={pwErr}
                hint={isReg ? `Придумай свой, минимум ${PASSWORD_MIN} символов.` : undefined}
              >
                <div className="relative">
                  <Input
                    ref={pwRef}
                    id="password"
                    name="password"
                    type={showPw ? "text" : "password"}
                    autoComplete={isReg ? "new-password" : "current-password"}
                    placeholder={isReg ? "Придумай пароль" : "Твой пароль"}
                    className="pr-11"
                    value={password}
                    disabled={busy}
                    aria-invalid={pwErr ? true : undefined}
                    onChange={(ev) => {
                      setPassword(ev.target.value);
                      if (pwErr) setPwErr(undefined);
                      if (formErr) setFormErr(undefined);
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPw((v) => !v)}
                    className="absolute inset-y-0 right-0 flex w-11 cursor-pointer items-center justify-center text-text-3 transition-colors hover:text-text-2"
                    aria-label={showPw ? "Скрыть пароль" : "Показать пароль"}
                  >
                    {showPw ? (
                      <EyeOff className="h-[18px] w-[18px]" strokeWidth={1.75} aria-hidden />
                    ) : (
                      <Eye className="h-[18px] w-[18px]" strokeWidth={1.75} aria-hidden />
                    )}
                  </button>
                </div>
              </Field>
            </div>

            {/* Общая ошибка (почта занята / неверный вход) */}
            <AnimatePresence initial={false}>
              {formErr && (
                <motion.p
                  key={formErr}
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: reduce ? 0 : 0.2 }}
                  className="mt-3 rounded-xs bg-danger-soft px-3.5 py-2.5 text-[13px] leading-relaxed font-medium text-danger-text"
                  role="alert"
                >
                  {formErr}
                </motion.p>
              )}
            </AnimatePresence>

            <Button
              type="submit"
              variant="brand"
              size="lg"
              className="mt-5 w-full"
              loading={pending}
              disabled={busy}
            >
              {isReg ? "Создать аккаунт" : "Войти"}
            </Button>
            {!isReg && (
              <p className="mt-3 text-center text-[13px]">
                <Link
                  href="/forgot-password"
                  className="font-semibold text-brand hover:underline"
                >
                  Не помню пароль
                </Link>
              </p>
            )}
          </motion.form>

          <motion.p {...rise(0.42)} className="mt-6 text-[13px] leading-relaxed text-text-3">
            {isReg ? (
              <>
                Уже есть аккаунт?{" "}
                <button
                  type="button"
                  onClick={() => switchMode("login")}
                  className="inline-flex min-h-11 min-w-11 cursor-pointer items-center justify-center font-semibold text-brand hover:underline"
                >
                  Войти
                </button>
              </>
            ) : (
              <>
                Ещё нет аккаунта?{" "}
                <button
                  type="button"
                  onClick={() => switchMode("register")}
                  className="inline-flex min-h-11 min-w-11 cursor-pointer items-center justify-center font-semibold text-brand hover:underline"
                >
                  Зарегистрироваться
                </button>
              </>
            )}
          </motion.p>

          <motion.div {...rise(0.48)} className="mt-5">
            <Badge tone="neutral">
              <span className="text-left leading-snug">
                Работает из любой страны. Мы не просим карту и не шлём спам
              </span>
            </Badge>
          </motion.div>
        </div>

        {/* ═══════════════════════════════════════ ПРАВО: витрина ценности */}
        <motion.aside
          initial="hidden"
          animate="show"
          variants={reduce ? still : stagger}
          className="hidden lg:flex"
          aria-labelledby="value-title"
        >
          <GlassCard strong className="w-full p-9">
            <motion.h2
              id="value-title"
              variants={reduce ? still : item}
              className="text-2xl font-extrabold -tracking-[0.02em] text-text"
            >
              Что тебя ждёт внутри
            </motion.h2>

            <ul className="mt-7 space-y-4">
              {VALUE.map(({ icon: Icon, tint, text }) => (
                <motion.li key={text} variants={reduce ? still : item} className="flex items-start gap-4">
                  <span
                    className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-[4px] border-2 border-line bg-surface ${tint}`}
                  >
                    <Icon className="h-5 w-5" strokeWidth={1.75} aria-hidden />
                  </span>
                  <p className="pt-[9px] text-[15px] leading-snug text-text">{text}</p>
                </motion.li>
              ))}
            </ul>

            <motion.div variants={reduce ? still : item}>
              <Divider className="my-7" />
              <blockquote>
                <p className="text-[15px] leading-relaxed font-semibold text-text">
                  «От регистрации до первого запланированного поста — не больше 5 минут.»
                </p>
                <footer className="mt-2 text-[13px] text-text-3">критерий приёмки, а не обещание</footer>
              </blockquote>
            </motion.div>
          </GlassCard>
        </motion.aside>
      </div>
    </main>
  );
}
