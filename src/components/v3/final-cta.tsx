"use client";

// Финальный призыв + футер v3. Огромный жёлтый блок с формой листа ожидания.
// Форма бьёт в существующий /api/lead (та же схема, что и у боевого лендинга):
// honeypot против ботов, честный запасной путь в Telegram при сбое сервера.
import { useRef, useState } from "react";
import Link from "next/link";
import { motion, useReducedMotion } from "motion/react";
import { ArrowRight, Check, Send } from "lucide-react";
import { ERR_SHAPE, validateContact } from "@/lib/leads";
import { V3Reveal } from "./reveal";

const EASE = [0.22, 1, 0.36, 1] as const;
const HEADLINE = ["Бесплатно.", "Без карты.", "Из России."] as const;

// Запасной путь, если сервер не ответил — ведёт к нашему боту
const SUPPORT_TG = "https://t.me/kontenfkv_bot";

export function V3FinalCta() {
  const reduce = useReducedMotion();
  const inputRef = useRef<HTMLInputElement>(null);

  const [contact, setContact] = useState("");
  const [honeypot, setHoneypot] = useState("");
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [serverDown, setServerDown] = useState(false);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (loading) return;

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
      const res = await fetch("/api/lead", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contact: contact.trim(),
          source: "v3_final_waitlist",
          website: honeypot, // honeypot: у людей пусто
        }),
      });
      const data = (await res.json().catch(() => null)) as
        | { ok: boolean; duplicate?: boolean; error?: string }
        | null;

      if (res.ok && data?.ok) {
        setDone(true);
      } else if (res.status === 422 || data?.error === "not_contact") {
        setError(ERR_SHAPE);
        inputRef.current?.focus();
      } else {
        setServerDown(true);
      }
    } catch {
      setServerDown(true);
    } finally {
      setLoading(false);
    }
  }

  return (
    <section id="cta" aria-labelledby="v3-cta-title" className="py-20 sm:py-28">
      {/* Full-bleed: жёлтый лист во всю ширину, композиция внутри — по центру */}
      <div className="v3-wrap">
        <V3Reveal>
          <div className="relative border-3 border-[var(--ink)] bg-[var(--acc)] p-8 text-center shadow-[10px_10px_0_var(--ink)] sm:p-14">
            <span className="v3-stamp absolute -top-3.5 left-1/2 -translate-x-1/2">
              Ранний доступ открыт
            </span>

            <h2
              id="v3-cta-title"
              className="v3-display text-[clamp(2.2rem,6vw,4.4rem)] leading-[1.02] font-black uppercase"
            >
              {HEADLINE.map((line) => (
                <span key={line} className="block">
                  {line}
                </span>
              ))}
            </h2>

            <p className="mx-auto mt-6 max-w-md text-[16px] leading-relaxed font-semibold">
              Подключаешь канал — и через пять минут разведка уже работает на тебя.
            </p>

            <div className="mt-9">
              <Link href="/register" className="v3-btn v3-btn--ink v3-btn--lg">
                Забрать ранний доступ
                <ArrowRight className="h-4 w-4" strokeWidth={2.5} aria-hidden />
              </Link>
            </div>

            {/* Запасной путь: лист ожидания одним полем */}
            <div className="mx-auto mt-10 max-w-md border-t-2 border-[var(--ink)] pt-8">
              {done ? (
                <motion.p
                  initial={reduce ? false : { scale: 1.3, opacity: 0, rotate: -8 }}
                  animate={{ scale: 1, opacity: 1, rotate: -3 }}
                  transition={{ duration: 0.3, ease: EASE }}
                  className="v3-stamp v3-stamp--green mx-auto"
                >
                  <Check className="mr-1 inline h-3.5 w-3.5" strokeWidth={3.5} aria-hidden />
                  Ты в списке — напишем первым
                </motion.p>
              ) : (
                <>
                  <p className="v3-mono text-[11px] font-semibold tracking-[0.12em] uppercase">
                    Или оставь контакт — позовём, когда откроем новую волну
                  </p>
                  <form onSubmit={handleSubmit} className="mt-4 flex flex-col gap-4 sm:flex-row" noValidate>
                    <label className="sr-only" htmlFor="v3-lead-contact">
                      Почта или Telegram
                    </label>
                    <input
                      ref={inputRef}
                      id="v3-lead-contact"
                      type="text"
                      inputMode="email"
                      autoComplete="email"
                      placeholder="почта или @telegram"
                      value={contact}
                      onChange={(e) => setContact(e.target.value)}
                      className="v3-input flex-1"
                      aria-invalid={Boolean(error)}
                      aria-describedby={error ? "v3-lead-error" : undefined}
                    />
                    {/* Honeypot: невидим людям, заполняется ботами */}
                    <input
                      type="text"
                      name="website"
                      value={honeypot}
                      onChange={(e) => setHoneypot(e.target.value)}
                      tabIndex={-1}
                      autoComplete="off"
                      aria-hidden="true"
                      className="hidden"
                    />
                    <button type="submit" disabled={loading} className="v3-btn v3-btn--ghost shrink-0">
                      {loading ? "Шлю…" : "В список"}
                      {!loading && <Send className="h-4 w-4" strokeWidth={2.5} aria-hidden />}
                    </button>
                  </form>
                  {error && (
                    <p id="v3-lead-error" role="alert" className="mt-3 text-[13.5px] font-semibold">
                      {error}
                    </p>
                  )}
                  {serverDown && (
                    <p role="alert" className="mt-3 text-[13.5px] font-semibold">
                      Сервер не ответил — напиши нам напрямую:{" "}
                      <a href={SUPPORT_TG} className="underline decoration-2 underline-offset-4">
                        @kontenfkv_bot
                      </a>
                    </p>
                  )}
                </>
              )}
            </div>
          </div>
        </V3Reveal>
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------- ФУТЕР */

export function V3Footer() {
  return (
    <footer className="border-t-2 border-[var(--ink)] bg-[var(--ink)] text-[var(--paper)]">
      <div className="v3-wrap flex flex-col gap-8 py-12 md:flex-row md:items-start md:justify-between">
        <div>
          <p className="flex items-center gap-2.5">
            <span
              aria-hidden
              className="flex h-8 w-8 items-center justify-center border-2 border-[var(--paper)] bg-[var(--acc)] font-[family-name:var(--v3-display)] text-[15px] font-black text-[var(--ink)]"
            >
              А
            </span>
            <span className="font-[family-name:var(--v3-display)] text-[15px] font-bold tracking-[0.08em] uppercase">
              Аврора
            </span>
          </p>
          <p className="v3-mono mt-4 max-w-xs text-[11.5px] leading-relaxed tracking-[0.06em] uppercase opacity-70">
            Канал ведётся сам. Сделано в России.
          </p>
        </div>

        <nav aria-label="Разделы лендинга" className="v3-mono flex flex-col gap-3 text-[12px] tracking-[0.08em] uppercase">
          <a href="#how" className="opacity-80 transition-opacity hover:opacity-100 hover:underline hover:decoration-2 hover:underline-offset-4">
            Как это работает
          </a>
          <a href="#compare" className="opacity-80 transition-opacity hover:opacity-100 hover:underline hover:decoration-2 hover:underline-offset-4">
            Сравнение
          </a>
          <a href="#pricing" className="opacity-80 transition-opacity hover:opacity-100 hover:underline hover:decoration-2 hover:underline-offset-4">
            Тарифы
          </a>
          <a href="#faq" className="opacity-80 transition-opacity hover:opacity-100 hover:underline hover:decoration-2 hover:underline-offset-4">
            Вопросы
          </a>
        </nav>

        <div className="v3-mono text-[12px] tracking-[0.08em] uppercase">
          <a
            href={SUPPORT_TG}
            className="inline-flex items-center gap-2 border-2 border-[var(--paper)] px-4 py-2.5 transition-colors hover:bg-[var(--paper)] hover:text-[var(--ink)]"
          >
            <Send className="h-3.5 w-3.5" strokeWidth={2.5} aria-hidden />
            @kontenfkv_bot
          </a>
          <p className="mt-4 opacity-60">© 2026 Аврора</p>
        </div>
      </div>
    </footer>
  );
}
