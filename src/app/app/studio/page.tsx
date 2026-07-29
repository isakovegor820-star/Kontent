"use client";

// А9. ИИ-студия (ТЗ 5.6, Приложение А).
// Диалог + быстрые команды. ИИ помнит стиль пользователя и опирается на разведку.
// Главное действие — сгенерировать и отправить в календарь.

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { motion, useReducedMotion } from "motion/react";
import {
  ArrowRight,
  ArrowUp,
  Brain,
  CalendarPlus,
  CalendarRange,
  ChevronDown,
  Clapperboard,
  Copy,
  Cpu,
  FileText,
  Flame,
  ImageIcon,
  ListChecks,
  Pencil,
  Radar,
  RefreshCw,
  Sparkles,
  Square,
  Zap,
} from "lucide-react";

import { AppShell } from "@/components/app/shell";
import { Button } from "@/components/ui/button";
import { Badge, Card, EmptyState, Input, Textarea } from "@/components/ui/primitives";
import { type AiCommand } from "@/lib/ai";
import type { AiRole } from "@/lib/ai-provider";
import { useStore } from "@/lib/store";
import { cn, fmtCompact, plural, uid } from "@/lib/utils";

/* --------------------------------------------------------------- ОСНОВЫ */

type Msg = {
  id: string;
  role: "user" | "ai";
  text: string;
  streaming?: boolean;
  postable?: boolean;
};

/** Что ИИ должен «помнить» для перегенерации ответа */
type Gen = { cmd: AiCommand; input: string; variant: number };

const EASE_SOFT: [number, number, number, number] = [0.22, 1, 0.36, 1];

const GREETING =
  "Привет. Могу написать пост, собрать план на неделю, придумать сценарий видео или подобрать картинку. Скажи, что нужно — или жми быструю команду ниже.";

const ICON = "h-4 w-4";

type Quick = {
  id: string;
  label: string;
  icon: React.ReactNode;
  /** подставить заготовку в поле — человек дописывает тему сам */
  draft?: string;
  /** выполнить сразу, дописывать нечего */
  instant?: string;
};

const QUICK: Quick[] = [
  {
    id: "write",
    label: "Пост на тему…",
    icon: <Sparkles className={ICON} strokeWidth={2} aria-hidden />,
    draft: "Напиши пост на тему: ",
  },
  {
    id: "plan",
    label: "План на неделю",
    icon: <CalendarRange className={ICON} strokeWidth={2} aria-hidden />,
    instant: "Собери план на неделю",
  },
  {
    id: "script",
    label: "Сценарий видео",
    icon: <Clapperboard className={ICON} strokeWidth={2} aria-hidden />,
    draft: "Придумай сценарий видео про ",
  },
  {
    id: "poll",
    label: "Опрос",
    icon: <ListChecks className={ICON} strokeWidth={2} aria-hidden />,
    draft: "Придумай опрос на тему: ",
  },
  {
    id: "longread",
    label: "Лонгрид",
    icon: <FileText className={ICON} strokeWidth={2} aria-hidden />,
    draft: "Напиши лонгрид про ",
  },
  {
    id: "image",
    label: "Картинка",
    icon: <ImageIcon className={ICON} strokeWidth={2} aria-hidden />,
    draft: "Подбери картинку к посту про ",
  },
  {
    id: "rewrite-last",
    label: "Перепиши последнее",
    icon: <RefreshCw className={ICON} strokeWidth={2} aria-hidden />,
  },
];

/** Эвристика: понимаем, что человек хочет, по его же словам — без меню и настроек */
function pickCommand(text: string): AiCommand {
  const t = text.toLowerCase();
  if (t.includes("план")) return "plan";
  if (t.includes("сценар") || t.includes("видео")) return "script";
  if (t.includes("сократ")) return "shorten";
  if (t.includes("перепиш")) return "rewrite";
  if (t.includes("картинк")) return "image";
  if (t.includes("опрос") || t.includes("голосован")) return "poll";
  if (t.includes("лонгрид") || t.includes("длинн")) return "longread";
  return "write";
}

// Примеры для пустого диалога: показать, что тут вообще можно попросить, вместо голого поля.
// Нейтральные по нише — конкретика приедет из настроек и разведки, выдумывать её не надо.
const SUGGESTIONS = [
  "Разбери частую ошибку в моей теме — коротко и по делу",
  "Пост из личной истории: что я понял на своём опыте",
  "Ответь на частый вопрос подписчиков",
  "Мини-инструкция за 5 шагов",
];

/* ------------------------------------------------------------- СООБЩЕНИЕ */

function MessageRow({
  msg,
  reduce,
  onStop,
  onSchedule,
  onCopy,
  onRegenerate,
}: {
  msg: Msg;
  reduce: boolean;
  onStop: () => void;
  onSchedule: () => void;
  onCopy: () => void;
  onRegenerate: () => void;
}) {
  const appear = {
    initial: reduce ? false : { opacity: 0, y: 10 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.26, ease: EASE_SOFT },
  };

  // Пользователь — справа, градиентный пузырь со срезанным углом
  if (msg.role === "user") {
    return (
      <motion.div {...appear} className="flex w-full shrink-0 justify-end">
        <div className="w-fit max-w-[min(88%,34rem)] rounded-2xl rounded-br-sm border-2 border-line bg-brand-gradient px-4 py-3 shadow-soft">
          <p className="text-[15px] leading-relaxed whitespace-pre-wrap text-text">{msg.text}</p>
        </div>
      </motion.div>
    );
  }

  const ready = !msg.streaming && msg.text.trim().length > 0;

  // ИИ — слева, спокойная карточка с логотипом-аватаром
  return (
    <motion.div {...appear} className="flex w-full shrink-0 gap-3">
      <span
        aria-hidden
        className="mt-1 grid h-7 w-7 shrink-0 place-items-center rounded-[4px] border-2 border-line bg-[var(--acc)] font-[family-name:var(--v3-display)] text-[13px] font-black text-text shadow-[2px_2px_0_var(--ink)]"
      >
        А
      </span>

      <div className="min-w-0 flex-1">
        <div className="card-plain w-fit max-w-full rounded-2xl rounded-tl-sm px-4 py-3">
          <p
            className={cn(
              "text-[15px] leading-relaxed whitespace-pre-wrap text-text",
              msg.streaming && "caret",
            )}
          >
            {msg.text}
          </p>
        </div>

        {/* Печатает — можно остановить. Анимация никогда не держит человека (ТЗ 7.4) */}
        {msg.streaming && (
          <div className="mt-2">
            <Button variant="ghost" size="sm" onClick={onStop}>
              <Square className="h-3 w-3" fill="currentColor" strokeWidth={2} aria-hidden />
              Стоп
            </Button>
          </div>
        )}

        {/* Готовый текст → главное действие экрана: отправить в календарь */}
        {ready && msg.postable && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <Button variant="soft" size="sm" onClick={onSchedule}>
              <CalendarPlus className="h-4 w-4 text-brand" strokeWidth={2} aria-hidden />В календарь
            </Button>
            <Button variant="ghost" size="sm" onClick={onCopy}>
              <Copy className="h-4 w-4" strokeWidth={2} aria-hidden />
              Скопировать
            </Button>
            <Button variant="ghost" size="sm" onClick={onRegenerate}>
              <RefreshCw className="h-4 w-4" strokeWidth={2} aria-hidden />
              Ещё вариант
            </Button>
          </div>
        )}
      </div>
    </motion.div>
  );
}

/* ------------------------------------------------- СТРОКА ПАМЯТИ СТИЛИ */

function EditableRow({
  label,
  value,
  onSave,
}: {
  label: string;
  value: string;
  onSave: (v: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLInputElement>(null);
  const cancelled = useRef(false);

  useEffect(() => {
    if (editing) ref.current?.focus();
  }, [editing]);

  // Черновик берём в момент открытия — он всегда свежий, синхронизировать нечего
  const open = () => {
    setDraft(value);
    setEditing(true);
  };

  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (!next || next === value) return;
    onSave(next);
  };

  if (editing) {
    return (
      <div>
        <p className="text-[13px] font-semibold text-text-3">{label}</p>
        <Input
          ref={ref}
          value={draft}
          aria-label={label}
          className="mt-1"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            if (cancelled.current) {
              cancelled.current = false;
              return;
            }
            commit();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              e.currentTarget.blur();
            }
            if (e.key === "Escape") {
              cancelled.current = true;
              setEditing(false);
            }
          }}
        />
      </div>
    );
  }

  return (
    <div>
      <p className="text-[13px] font-semibold text-text-3">{label}</p>
      <button
        type="button"
        onClick={open}
        aria-label={`Изменить: ${label}`}
        className={cn(
          "group -mx-2 mt-0.5 flex min-h-11 w-full cursor-pointer items-start gap-2 rounded-xs px-2 py-2 text-left",
          "transition-colors duration-200 hover:bg-surface-inset",
        )}
      >
        <span className="flex-1 text-[14px] leading-snug text-text">{value}</span>
        <Pencil
          className={cn(
            "mt-0.5 h-3.5 w-3.5 shrink-0 text-text-3 opacity-0 transition-opacity duration-200",
            "group-hover:opacity-100 group-focus-visible:opacity-100",
          )}
          strokeWidth={2}
          aria-hidden
        />
      </button>
    </div>
  );
}

/* ----------------------------------------------------------- СКЕЛЕТОНЫ */

function StudioSkeleton() {
  return (
    <div className="flex flex-col gap-6 xl:flex-row xl:items-start">
      <div className="flex min-w-0 flex-1 flex-col rounded-xl border border-line bg-surface-2 shadow-soft">
        <div className="flex h-[clamp(340px,58dvh,560px)] flex-col gap-5 p-4 md:p-5">
          <div className="flex gap-3">
            <div className="skeleton h-7 w-7 shrink-0" />
            <div className="skeleton h-20 w-3/4" />
          </div>
          <div className="skeleton ml-auto h-12 w-2/5" />
          <div className="flex gap-3">
            <div className="skeleton h-7 w-7 shrink-0" />
            <div className="skeleton h-28 w-4/5" />
          </div>
        </div>
        <div className="flex flex-col gap-3 border-t border-line p-4 md:p-5">
          <div className="flex gap-2">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="skeleton h-11 w-32 shrink-0" />
            ))}
          </div>
          <div className="skeleton h-[86px] w-full" />
        </div>
      </div>

      <aside className="hidden w-[300px] shrink-0 xl:block">
        <div className="flex flex-col gap-4">
          {Array.from({ length: 3 }, (_, i) => (
            <Card key={i} className="flex flex-col gap-3 p-4">
              <div className="skeleton h-5 w-36" />
              <div className="skeleton h-16 w-full" />
              <div className="skeleton h-10 w-full" />
            </Card>
          ))}
        </div>
      </aside>
    </div>
  );
}

/* ------------------------------------------------------------ ДВИЖОК ИИ */
// Выбор модели-агента. Облачные движки пока ждут ключа — и мы говорим это прямо, а не
// красим кнопку в активный вид. Выбор сохраняется даже без ключа: появится ключ — заработает.
// Если выбран движок без ключа, генерация честно откажет (см. /api/ai/generate) — тайком
// подменять модель мы не станем, иначе «выбор модели» превращается в декорацию.

interface EngineInfo {
  id: string;
  label: string;
  vendor: string;
  note: string;
  needs: string | null;
  ruFriendly: boolean;
  status: "ready" | "no_key" | "offline";
  reason: string | null;
}

/** Настоящая разведка из /api/trends — то, на что ИИ реально может опереться. */
interface ReconItem {
  id: number;
  competitorTitle: string | null;
  handle: string;
  text: string | null;
  ratio: number;
  median: number;
  views: number;
  postedAt: string;
  link: string;
}
interface ReconData {
  status: { competitors: number; posts: number };
  items: ReconItem[];
}

const engineDot = (st: EngineInfo["status"]) =>
  st === "ready" ? "bg-success-text" : st === "no_key" ? "bg-text-3/40" : "bg-danger-text";

/** Общая обёртка для выпадашек панели: клик вне и Esc закрывают (правило escape-routes). */
function Popover({
  open,
  onClose,
  children,
  className,
}: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      ref={ref}
      className={cn(
        // Открываем вверх — панель прижата к низу экрана. Высоту ограничиваем вьюпортом:
        // без этого длинный список уезжал за верхний край и обрезался.
        "absolute bottom-[calc(100%+8px)] left-0 z-40 w-[320px] max-w-[calc(100vw-2rem)]",
        "max-h-[min(60dvh,420px)] overflow-y-auto overscroll-contain",
        "rounded-md border border-line-strong bg-surface-2 p-2 shadow-lift",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Чип-переключатель движка. Живёт у поля ввода — там, где им пользуются. */
function EngineChip({
  engines,
  current,
  onPick,
  loading,
}: {
  engines: EngineInfo[];
  current: string | null;
  onPick: (e: EngineInfo) => void;
  loading: boolean;
}) {
  const [open, setOpen] = useState(false);
  const active = engines.find((e) => e.id === current);

  if (loading) return <div className="skeleton h-9 w-36 rounded-full" />;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={`Движок: ${active?.label ?? "не выбран"}. Сменить`}
        className={cn(
          "clay-sm inline-flex h-9 cursor-pointer items-center gap-2 px-3.5 text-[13px] font-semibold",
          "transition-[box-shadow,color] duration-200",
          // Открытая выпадашка = чип вдавлен: видно, что он «нажат», без смены цвета
          open && "clay-press",
          active && active.status !== "ready" ? "text-text-2" : "text-text",
        )}
      >
        <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", engineDot(active?.status ?? "no_key"))} aria-hidden />
        <Cpu className="h-3.5 w-3.5 text-text-3" aria-hidden />
        <span className="max-w-[120px] truncate">{active?.label ?? "Движок"}</span>
        <ChevronDown className={cn("h-3.5 w-3.5 text-text-3 transition-transform", open && "rotate-180")} aria-hidden />
      </button>

      <Popover open={open} onClose={() => setOpen(false)}>
        <ul role="listbox" className="flex flex-col gap-0.5">
          {engines.map((e) => (
            <li key={e.id}>
              <button
                type="button"
                role="option"
                aria-selected={e.id === current}
                aria-label={`${e.label}, ${e.vendor}. ${e.status === "ready" ? "Работает сейчас" : e.status === "no_key" ? `Нужен ключ ${e.needs}` : "Не отвечает"}`}
                onClick={() => {
                  onPick(e);
                  setOpen(false);
                }}
                className={cn(
                  "flex w-full cursor-pointer items-start gap-2.5 rounded-sm px-2.5 py-2 text-left transition-colors",
                  e.id === current ? "bg-info-soft" : "hover:bg-surface-inset",
                )}
              >
                <span className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", engineDot(e.status))} aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-[13px] font-semibold text-text">{e.label}</span>
                    <span className="shrink-0 text-[11px] text-text-3">{e.vendor}</span>
                    {e.ruFriendly && (
                      <span className="shrink-0 rounded-full bg-surface-inset px-1.5 text-[10px] font-bold text-text-3">
                        РФ
                      </span>
                    )}
                  </span>
                  <span className="mt-0.5 block text-[11px] leading-snug text-text-3">
                    {e.status === "ready"
                      ? "работает сейчас"
                      : e.status === "no_key"
                        ? `нужен ключ ${e.needs}`
                        : "не отвечает"}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
        <p className="mt-1.5 border-t border-line px-2.5 pt-2 text-[11px] leading-relaxed text-text-3">
          Выбор сохранится и без ключа. Подменять модель втихую не будем: нет движка — генерация
          честно откажет.
        </p>
      </Popover>
    </div>
  );
}

/** Чип стиля: настроение + ниша + тон. Раньше это жило в правой колонке, которая скрыта
 *  до 1280px — то есть на ноутбуке настройки просто отсутствовали. Теперь они у поля ввода. */
function StyleChip({
  mood,
  moods,
  onMood,
  niche,
  tone,
  onNiche,
  onTone,
}: {
  mood: string;
  moods: { key: string; label: string; emoji: string }[];
  onMood: (k: string) => void;
  niche: string;
  tone: string;
  onNiche: (v: string) => void;
  onTone: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const active = moods.find((m) => m.key === mood);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={`Стиль: настроение ${active?.label ?? "не выбрано"}. Изменить`}
        className={cn(
          "clay-sm inline-flex h-9 cursor-pointer items-center gap-2 px-3.5 text-[13px] font-semibold text-text",
          "transition-[box-shadow] duration-200",
          open && "clay-press",
        )}
      >
        <Brain className="h-3.5 w-3.5 text-text-3" aria-hidden />
        <span className="max-w-[110px] truncate">{active?.label ?? "Стиль"}</span>
        <ChevronDown className={cn("h-3.5 w-3.5 text-text-3 transition-transform", open && "rotate-180")} aria-hidden />
      </button>

      <Popover open={open} onClose={() => setOpen(false)} className="w-[340px] p-3">
        <p className="text-[12px] font-semibold text-text-3">Настроение</p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {moods.map((m) => (
            <button
              key={m.key}
              type="button"
              onClick={() => onMood(m.key)}
              aria-pressed={mood === m.key}
              className={cn(
                "inline-flex min-h-9 cursor-pointer items-center gap-1 rounded-full border px-2.5 text-[13px] font-semibold transition-colors",
                mood === m.key
                  ? "border-brand bg-info-soft text-brand"
                  : "border-line text-text-2 hover:bg-surface-inset",
              )}
            >
              <span aria-hidden>{m.emoji}</span>
              {m.label}
            </button>
          ))}
        </div>

        <div className="mt-3 flex flex-col gap-2 border-t border-line pt-3">
          <EditableRow label="Ниша" value={niche} onSave={onNiche} />
          <EditableRow label="Тон" value={tone} onSave={onTone} />
        </div>

        <p className="mt-3 border-t border-line pt-2 text-[11px] leading-relaxed text-text-3">
          Перед каждой генерацией ИИ подкладывает твои прошлые посты как образец стиля — поэтому
          пишет ближе к твоему голосу.
        </p>
      </Popover>
    </div>
  );
}

/* --------------------------------------------------------------- ЭКРАН */

function StudioPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const s = useStore();
  const reduce = useReducedMotion() ?? false;

  const [messages, setMessages] = useState<Msg[]>([
    { id: "m_hello", role: "ai", text: GREETING },
  ]);
  const [draft, setDraft] = useState("");
  // Роль ИИ: модифицирует системный промпт (копирайтер / стратег / критик).
  const [role, setRole] = useState<AiRole | null>(null);
  // Настоящая разведка из базы — и для правой колонки, и как контекст в промпт.
  const [recon, setRecon] = useState<ReconData | null>(null);
  // Готовая строка контекста в ref: startStream живёт вне рендера и не должен пересоздаваться.
  const reconRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    fetch("/api/trends?scope=niche", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: ReconData | null) => {
        if (!d) return;
        setRecon(d);
        // Берём три верхних поста: что реально обогнало норму своего канала. Сервер обрежет
        // до 600 символов, поэтому сразу отдаём коротко и по делу.
        const top = d.items.slice(0, 3).filter((i) => i.text);
        reconRef.current = top.length
          ? "у соседей по нише сейчас лучше нормы заходит вот это — " +
            top
              .map(
                (i) =>
                  `«${i.text!.replace(/\s+/g, " ").slice(0, 110)}» (${i.competitorTitle || i.handle}, ×${i.ratio.toFixed(1)} к норме)`,
              )
              .join("; ")
          : undefined;
      })
      .catch(() => {});
  }, []);

  // Настроение агента (одно на аккаунт, из БД) — влияет на всю генерацию.
  const [mood, setMood] = useState<string>("friendly");
  const [moods, setMoods] = useState<{ key: string; label: string; emoji: string }[]>([]);

  const feedRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  /** Стабильная коробка под отмену печати — переживает ререндеры, чистится при уходе с экрана */
  const streamRef = useRef<{ cancel: (() => void) | null }>({ cancel: null });
  /** Чем был рождён каждый ответ ИИ — чтобы «Ещё вариант» знал, что перегенерировать */
  const genRef = useRef(new Map<string, Gen>());

  const busy = messages.some((m) => m.streaming);
  const streamingLen = messages.find((m) => m.streaming)?.text.length ?? 0;
  const count = messages.length;

  const used = s.aiUsed;
  const limit = s.aiLimit;
  const left = Math.max(0, limit - used);
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 100;

  // Новое сообщение — прокручиваем ленту вниз (уважая настройку «меньше движения»).
  // block: "nearest" — двигается только лента, страница под ней остаётся на месте.
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "nearest" });
  }, [count, reduce]);

  // Пока печатает — держим хвост в виду. Но если человек ушёл читать выше, скролл не вырываем.
  useEffect(() => {
    const el = feedRef.current;
    if (!el || streamingLen === 0) return;
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (gap < 160) el.scrollTop = el.scrollHeight;
  }, [streamingLen]);

  // Уходим с экрана — печать останавливается, таймеры не тикают в пустоту
  useEffect(() => {
    const box = streamRef.current;
    return () => {
      box.cancel?.();
      box.cancel = null;
    };
  }, []);

  // Пришли из досье конкурента с темой (?topic=…) — подставляем в поле, человек жмёт «отправить».
  useEffect(() => {
    const topic = searchParams.get("topic");
    // eslint-disable-next-line react-hooks/set-state-in-effect -- предзаполнение поля из ссылки
    if (topic) setDraft(`Напиши пост на тему: ${topic}`);
  }, [searchParams]);

  // Настроение агента и список пресетов — из базы.
  useEffect(() => {
    fetch("/api/settings", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        setMood(d.mood ?? "friendly");
        setMoods(d.moods ?? []);
      })
      .catch(() => {});
  }, []);

  // Чат должен быть ФИКСИРОВАННОЙ коробки: сообщения ездят внутри, поле ввода не двигается.
  // Раньше стояли min-h/max-h — контейнер рос под содержимое и толкал ввод вниз при каждом
  // новом сообщении. Высоту считаем от реального положения блока, а не магическим числом:
  // подзаголовок может перенестись на две строки, и константа сразу бы соврала.
  const shellRef = useRef<HTMLDivElement | null>(null);

  const fit = useCallback(() => {
    const el = shellRef.current;
    if (!el) return;
    const top = el.getBoundingClientRect().top + window.scrollY;
    // Нижний отступ берём у main, а не константой: на телефоне там pb-24 под нижнее меню,
    // на десктопе pb-10. Зашитое число увело бы ввод под панель навигации.
    const main = el.closest("main");
    const bottom = main ? parseFloat(getComputedStyle(main).paddingBottom) || 0 : 40;
    el.style.setProperty("--studio-h", `${Math.max(420, window.innerHeight - top - bottom)}px`);
  }, []);

  // Меряем в момент появления узла, а не в эффекте страницы: AppShell держит собственный
  // скелет, пока грузится сам, поэтому к моменту любого useEffect этой страницы div ещё
  // не смонтирован и ref пустой. Ref-колбэк срабатывает ровно тогда, когда узел появился.
  const attachShell = useCallback(
    (el: HTMLDivElement | null) => {
      shellRef.current = el;
      if (el) fit();
    },
    [fit],
  );

  useEffect(() => {
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [fit]);

  // Движки ИИ — состояние живёт здесь: чип у поля ввода и отказ генерации должны знать одно и то же.
  const [engines, setEngines] = useState<EngineInfo[]>([]);
  const [engine, setEngine] = useState<string | null>(null);
  const [enginesLoading, setEnginesLoading] = useState(true);
  useEffect(() => {
    fetch("/api/ai/engines", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { engines?: EngineInfo[]; current?: string } | null) => {
        if (!d) return;
        setEngines(d.engines ?? []);
        setEngine(d.current ?? null);
      })
      .catch(() => {})
      .finally(() => setEnginesLoading(false));
  }, []);

  const pickEngine = async (e: EngineInfo) => {
    setEngine(e.id);
    fetch("/api/ai/engines", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ engine: e.id }),
    }).catch(() => {});
    if (e.status === "ready") {
      s.toast({ kind: "success", title: `Пишу через ${e.label}`, body: e.note });
    } else {
      // Не притворяемся, что переключились: движка нет — так и говорим.
      s.toast({
        kind: "info",
        title: `${e.label} пока не подключён`,
        body: e.reason ?? `Выбор запомнил. Пока не подключим — генерация через него не пойдёт.`,
      });
    }
  };

  const pickMood = async (key: string) => {
    setMood(key);
    fetch("/api/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mood: key }),
    }).catch(() => {});
    const m = moods.find((x) => x.key === key);
    s.toast({
      kind: "info",
      title: `Настроение: ${m?.label ?? ""} ${m?.emoji ?? ""}`,
      body: "ИИ будет писать в этом настроении — в студии, автопилоте и идеях.",
    });
  };

  /* ------------------------------------------------------------ ДЕЙСТВИЯ */

  const limitToast = () =>
    s.toast({
      kind: "danger",
      title: "Лимит на сегодня исчерпан",
      body: `${limit} генераций в сутки — честный лимит, ИИ стоит денег. Обновится завтра.`,
    });

  // Настоящая генерация Д.8: стрим из /api/ai/generate (за ним переходник → Hermes).
  // Сервер подкладывает прошлые посты как образец стиля и считает дневной лимит.
  const startStream = async (id: string, gen: Gen) => {
    const controller = new AbortController();
    streamRef.current.cancel = () => controller.abort();

    const clearCancel = () => {
      if (streamRef.current.cancel) streamRef.current.cancel = null;
    };
    const setMsg = (patch: Partial<Msg>) =>
      setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch } : m)));

    try {
      const res = await fetch("/api/ai/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          command: gen.cmd,
          input: gen.input,
          niche: s.settings.niche,
          tone: s.settings.tone,
          role: role ?? undefined,
          // Разведка едет в промпт по-настоящему. Раньше правая колонка обещала «ИИ смотрит
          // на конкурентов», а в запрос не уходило ни байта об этом — обещание было пустым.
          context: reconRef.current,
        }),
      });

      // Лимит исчерпан — убираем пустой пузырь, показываем честный тост.
      if (res.status === 429) {
        clearCancel();
        genRef.current.delete(id);
        setMessages((prev) => prev.filter((m) => m.id !== id));
        limitToast();
        void s.refreshAiUsage();
        return;
      }
      // Движок не поднят — честно говорим, что именно и что делать. Два разных случая:
      // выбран облачный движок без ключа, либо локальный Ollama не отвечает.
      if (res.status === 503) {
        clearCancel();
        const info = (await res.json().catch(() => null)) as
          | { error?: string; label?: string; needs?: string }
          | null;
        setMsg({
          text:
            info?.error === "engine_not_connected"
              ? `Ты выбрал ${info.label} — он ещё не подключён, поэтому писать через него я не могу. ` +
                `Нужен ключ в ${info.needs}. Подменять модель втихую не буду: выбери в «Движке» тот, что работает, или подключи ключ.`
              : "ИИ-движок сейчас недоступен. Проверь, что запущен Ollama с моделью hermes3, и попробуй снова.",
          streaming: false,
          postable: false,
        });
        return;
      }
      if (!res.ok || !res.body) {
        clearCancel();
        setMsg({ text: "Не получилось сгенерировать. Попробуй ещё раз.", streaming: false, postable: false });
        return;
      }

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let acc = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        acc += dec.decode(value, { stream: true });
        setMsg({ text: acc });
      }
      clearCancel();
      setMsg({ streaming: false });
      void s.refreshAiUsage();
    } catch (err) {
      clearCancel();
      // «Стоп» пользователя = AbortError: просто фиксируем, что успело напечататься.
      const aborted = (err as Error)?.name === "AbortError";
      setMessages((prev) =>
        prev.map((m) =>
          m.id === id
            ? {
                ...m,
                streaming: false,
                text: !aborted && !m.text ? "Связь с ИИ прервалась. Попробуй ещё раз." : m.text,
              }
            : m,
        ),
      );
      void s.refreshAiUsage();
    }
  };

  const ask = (userText: string, opts?: { cmd?: AiCommand; input?: string }) => {
    const text = userText.trim();
    if (!text || streamRef.current.cancel) return;

    // Честный дневной лимит (ТЗ 12): оптимистично проверяем на клиенте, сервер — финальный судья.
    if (used >= limit) {
      limitToast();
      return;
    }

    const cmd = opts?.cmd ?? pickCommand(text);
    const gen: Gen = { cmd, input: opts?.input ?? text, variant: 0 };
    const aiId = uid("m");

    genRef.current.set(aiId, gen);
    setMessages((prev) => [
      ...prev,
      { id: uid("m"), role: "user", text },
      { id: aiId, role: "ai", text: "", streaming: true, postable: cmd !== "image" },
    ]);
    setDraft("");
    void startStream(aiId, gen);
  };

  const stop = () => {
    streamRef.current.cancel?.();
    streamRef.current.cancel = null;
    setMessages((prev) => prev.map((m) => (m.streaming ? { ...m, streaming: false } : m)));
  };

  const regenerate = (id: string) => {
    if (streamRef.current.cancel) return;
    const gen = genRef.current.get(id);
    if (!gen) return;
    if (used >= limit) {
      limitToast();
      return;
    }

    const next: Gen = { ...gen, variant: gen.variant + 1 };
    genRef.current.set(id, next);
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, text: "", streaming: true } : m)));
    void startStream(id, next);
  };

  // Главное действие экрана
  const schedule = (text: string) => {
    const post = s.addPost({ text, status: "draft", origin: "ai" });
    s.toast({
      kind: "success",
      title: "Черновик готов",
      body: "Открываем редактор — поставь день и время, дальше пост уйдёт сам.",
    });
    router.push(`/app/composer?id=${post.id}`);
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      s.toast({ kind: "info", title: "Скопировано", body: "Текст в буфере обмена." });
    } catch {
      s.toast({
        kind: "danger",
        title: "Не получилось скопировать",
        body: "Браузер не дал доступ к буферу обмена. Выдели текст и скопируй вручную — он никуда не денется.",
      });
    }
  };

  const onQuick = (q: Quick) => {
    if (busy) return;

    if (q.id === "rewrite-last") {
      const last = [...messages]
        .reverse()
        .find((m) => m.role === "ai" && m.postable && m.text.trim().length > 0);

      if (!last) {
        s.toast({
          kind: "info",
          title: "Пока нечего переписывать",
          body: "Сначала попроси ИИ что-нибудь написать — а потом перепишем в один клик.",
        });
        return;
      }
      ask("Перепиши последнее", { cmd: "rewrite", input: last.text });
      return;
    }

    if (q.instant) {
      ask(q.instant);
      return;
    }

    if (q.draft) {
      setDraft(q.draft);
      // Курсор — сразу в конец заготовки: человек дописывает тему и жмёт Enter.
      // preventScroll — иначе браузер сам дёргает страницу к полю (ТЗ 7.4: ничего не прыгает)
      requestAnimationFrame(() => {
        const el = inputRef.current;
        if (!el) return;
        el.focus({ preventScroll: true });
        el.setSelectionRange(el.value.length, el.value.length);
      });
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    ask(draft);
  };

  /* -------------------------------------------------------- ПРАВАЯ КОЛОНКА */

  // Разведка — ТОЛЬКО из базы (/api/trends). Раньше здесь стоял s.competitors/s.trends из
  // стора, а он засеян моком: панель показывала демо-канал про кофе с залётами ×7,8 и ×9,2 —
  // числа, которых в Telegram не бывает (потолок к медиане ×2–4, проверено на живых каналах).
  const nCmp = recon?.status.competitors ?? 0;
  const flares = recon?.items.length ?? 0;
  const latest = recon?.items.slice(0, 2) ?? [];

  return (
    <AppShell
      title="ИИ-студия"
      subtitle="Пиши как в чате. ИИ помнит твой стиль и опирается на разведку."
    >
      {!s.ready ? (
        <StudioSkeleton />
      ) : (
        // Высота задаётся через --studio-h (посчитана от реального положения блока).
        // xl:items-start убран: колонка должна тянуться на всю высоту, а не по содержимому.
        <div
          ref={attachShell}
          className="flex h-[var(--studio-h)] flex-col gap-6 xl:flex-row"
        >
          {/* ------------------------------------------------------------ ЧАТ */}
          {/* Полотно ленты — на тон глубже пузырей, иначе карточка ИИ сливается с панелью */}
          {/* Мягкий язык: объём даёт тень, а не рамка. Поэтому border здесь нет — он бы
              спорил с тенью и вернул ту самую «коробочность», от которой уходим. */}
          {/* min-h-0 обязателен: у flex-элемента по умолчанию min-height:auto, и он отказывается
              сжиматься ниже своего содержимого — чат вылезал из фиксированного контейнера и
              толкал ввод вниз. Именно из-за этого «чат уезжал», а не из-за высоты контейнера. */}
          <section aria-label="Диалог с ИИ" className="clay flex min-h-0 min-w-0 flex-1 flex-col">
            {/* Лента прокручивается ВНУТРИ фиксированной коробки. min-h-0 обязателен: без него
                flex-элемент не даёт себя сжать ниже содержимого и коробка всё равно растёт. */}
            <div
              ref={feedRef}
              className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4 md:p-5"
            >
              {messages.map((m) => (
                <MessageRow
                  key={m.id}
                  msg={m}
                  reduce={reduce}
                  onStop={stop}
                  onSchedule={() => schedule(m.text)}
                  onCopy={() => void copy(m.text)}
                  onRegenerate={() => regenerate(m.id)}
                />
              ))}

              {/* Пустой диалог — не void, а подсказка с готовыми примерами (правило empty-states).
                  Показываем, только пока разговор не начался. */}
              {messages.length === 1 && (
                <div className="mt-1 flex flex-col gap-2">
                  <p className="text-[12px] font-semibold text-text-3">С чего начать</p>
                  <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                    {SUGGESTIONS.map((sg) => (
                      <button
                        key={sg}
                        type="button"
                        onClick={() => ask(sg)}
                        disabled={busy}
                        className={cn(
                          "clay rounded-md px-3.5 py-3 text-left text-[13px] leading-snug text-text-2",
                          "cursor-pointer transition-[box-shadow,color] duration-200 hover:text-text",
                          "active:clay-press disabled:pointer-events-none disabled:opacity-45 sm:max-w-[240px]",
                        )}
                      >
                        {sg}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div ref={endRef} className="h-px shrink-0" aria-hidden />
            </div>

            {/* shrink-0: ввод — якорь экрана, он не отдаёт свою высоту ленте ни при каких
                сообщениях. Именно это и есть «чат не уезжает вниз». */}
            <div className="shrink-0 p-4 md:p-5">
              {/* Панель управления — у поля ввода, а не в правой колонке: та скрыта до 1280px,
                  и на ноутбуке сменить модель или настроение было физически нельзя. */}
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <EngineChip
                  engines={engines}
                  current={engine}
                  onPick={pickEngine}
                  loading={enginesLoading}
                />
                <StyleChip
                  mood={mood}
                  moods={moods}
                  onMood={pickMood}
                  niche={s.settings.niche}
                  tone={s.settings.tone}
                  onNiche={(v) => {
                    s.updateSettings({ niche: v });
                    s.toast({ kind: "info", title: "Запомнил", body: "Следующие тексты будут ближе к этой теме." });
                  }}
                  onTone={(v) => {
                    s.updateSettings({ tone: v });
                    s.toast({ kind: "info", title: "Запомнил", body: "Следующие тексты будут звучать так." });
                  }}
                />
                <span className="nums ml-auto text-[12px] text-text-3">
                  {left} из {limit} на сегодня
                </span>
              </div>

              {/* Роль ИИ — переключает поведение модели */}
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[12px] font-semibold text-text-3">Роль:</span>
                {([null, "copywriter", "strategist", "critic"] as const).map((r) => (
                  <button
                    key={r ?? "default"}
                    type="button"
                    onClick={() => setRole(r)}
                    aria-pressed={role === r}
                    className={cn(
                      "rounded-full border px-2.5 py-1 text-[12px] font-semibold transition-colors",
                      role === r
                        ? "border-brand bg-info-soft text-info-text"
                        : "border-line text-text-3 hover:border-line-strong hover:text-text",
                    )}
                  >
                    {r === null ? "По умолчанию" : r === "copywriter" ? "Копирайтер" : r === "strategist" ? "Стратег" : "Критик"}
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-text-3">
                {role === "copywriter"
                  ? "Пишет посты: хук, структура, CTA"
                  : role === "strategist"
                    ? "Планирует: рубрики, контент-план, идеи"
                    : role === "critic"
                      ? "Разбирает текст: слабые места, улучшения"
                      : "Универсальный режим — подходит для большинства задач"}
              </p>

              {/* Быстрые команды — всегда на виду. На телефоне лента прокручивается вбок */}
              <div className="flex gap-2 overflow-x-auto pb-1 sm:flex-wrap sm:overflow-x-visible sm:pb-0">
                {QUICK.map((q) => (
                  <button
                    key={q.id}
                    type="button"
                    onClick={() => onQuick(q)}
                    disabled={busy}
                    className={cn(
                      "clay-sm group inline-flex h-11 shrink-0 cursor-pointer items-center gap-2",
                      "px-4 text-[14px] font-semibold whitespace-nowrap text-text",
                      // Нажатие вдавливает, а не двигает: габариты неизменны, layout не прыгает
                      "transition-[box-shadow,color] duration-200 ease-[var(--ease-soft)]",
                      "active:clay-press disabled:pointer-events-none disabled:opacity-45",
                    )}
                  >
                    <span className="text-text-2 transition-colors duration-200 group-hover:text-brand">
                      {q.icon}
                    </span>
                    {q.label}
                  </button>
                ))}
              </div>

              {/* Поле ввода. Кнопка отправки — единственный градиент на экране (ТЗ 7.2) */}
              <div className="relative mt-3">
                <Textarea
                  ref={inputRef}
                  rows={2}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={onKeyDown}
                  aria-label="Что написать ИИ"
                  placeholder="Напиши, о чём пост — или жми пример выше"
                  // Ввод — вдавленная поверхность: в этом языке «сюда наливают», а не «это лежит».
                  // Рамку снимаем (её роль играет тень), но фокус-кольцо остаётся: это доступность.
                  className="clay-in rounded-xl border-transparent pr-16 hover:border-transparent focus:border-transparent"
                />
                {/* Позицию держит обёртка: у самой кнопки в базовых классах есть relative */}
                <div className="absolute right-2.5 bottom-2.5">
                  <Button
                    variant="brand"
                    size="icon"
                    aria-label="Отправить"
                    disabled={busy || draft.trim().length === 0}
                    onClick={() => ask(draft)}
                  >
                    <ArrowUp className="h-5 w-5" strokeWidth={2.5} aria-hidden />
                  </Button>
                </div>
              </div>

              {/* Лимит теперь в панели над командами и виден всегда — второй раз не повторяем */}
              <p className="mt-2 text-[13px] text-text-3">
                Enter — отправить, Shift + Enter — новая строка.
              </p>
            </div>
          </section>

          {/* -------------------------------------------------- ПРАВАЯ КОЛОНКА */}
          {/* Колонка тянется на ту же высоту и прокручивается сама — страница не удлиняется */}
          <aside className="hidden w-[300px] shrink-0 xl:block xl:h-full xl:overflow-y-auto">
            <div className="flex flex-col gap-4">
              {/* 2. ОПОРА НА РАЗВЕДКУ */}
              <Card as="section" className="p-4">
                <header className="flex items-center gap-2">
                  <Radar className="h-[18px] w-[18px] text-brand" strokeWidth={2} aria-hidden />
                  <h2 className="text-[15px] font-extrabold tracking-tight text-text">
                    Опора на разведку
                  </h2>
                </header>

                <p className="mt-1.5 text-[13px] leading-relaxed text-text-2">
                  {nCmp > 0
                    ? `ИИ смотрит на ${nCmp} ${plural(nCmp, "конкурента", "конкурентов", "конкурентов")} и ${flares} ${plural(flares, "свежий залёт", "свежих залёта", "свежих залётов")}, когда пишет.`
                    : "Конкурентов пока нет — ИИ опирается только на твой стиль. Добавь пару каналов, и он начнёт подсматривать, что у них работает."}
                </p>

                {latest.length === 0 ? (
                  <EmptyState
                    icon={<Radar className="h-5 w-5" strokeWidth={1.5} aria-hidden />}
                    title="Разведки пока нет"
                    body="Добавь конкурентов — и лучшее из их постов появится здесь, а ИИ будет на это опираться."
                  />
                ) : (
                  <ul className="mt-3 flex flex-col gap-2">
                    {latest.map((t) => (
                      <li key={t.id} className="rounded-sm bg-surface-2 p-3 ring-1 ring-line">
                        <div className="flex items-start justify-between gap-2">
                          <p className="line-2 text-[14px] leading-snug font-semibold text-text">
                            {(t.text || "Пост без текста — только медиа").replace(/\s+/g, " ").slice(0, 80)}
                          </p>
                          <Badge tone={t.ratio >= 2 ? "fire" : "neutral"} className="shrink-0">
                            {t.ratio >= 2 && <Flame className="h-3 w-3" strokeWidth={2.5} aria-hidden />}
                            ×{t.ratio.toFixed(1).replace(".", ",")}
                          </Badge>
                        </div>
                        {/* Проверяемые числа, а не «доверься»: норма канала против этого поста */}
                        <p className="mt-1.5 text-[12px] text-text-3">
                          у «{t.competitorTitle || t.handle}» · норма {fmtCompact(t.median)} · этот{" "}
                          {fmtCompact(t.views)}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}

                <Link
                  href="/app/trends"
                  className={cn(
                    "mt-2 inline-flex min-h-11 items-center gap-1.5 text-[14px] font-semibold text-brand",
                    "transition-opacity duration-200 hover:opacity-75",
                  )}
                >
                  Все залёты и тренды
                  <ArrowRight className="h-4 w-4" strokeWidth={2} aria-hidden />
                </Link>
              </Card>

              {/* 3. ЛИМИТ ИИ — честно (ТЗ 12) */}
              <Card as="section" className="p-4">
                <header className="flex items-center justify-between gap-2">
                  <h2 className="flex items-center gap-2 text-[15px] font-extrabold tracking-tight text-text">
                    <Zap className="h-[18px] w-[18px] text-text-2" strokeWidth={2} aria-hidden />
                    Лимит ИИ
                  </h2>
                  <span className="nums text-[14px] font-bold text-text-2">
                    {used} / {limit}
                  </span>
                </header>

                <div
                  role="progressbar"
                  aria-valuenow={used}
                  aria-valuemin={0}
                  aria-valuemax={limit}
                  aria-label="Генераций израсходовано за сегодня"
                  className="mt-3 h-2 w-full overflow-hidden rounded-full bg-surface-inset"
                >
                  {/* Двигаем transform, а не width — так анимация не трогает раскладку (ТЗ 7.4) */}
                  <div
                    style={{ transform: `scaleX(${pct / 100})` }}
                    className={cn(
                      "h-full w-full origin-left rounded-full",
                      "transition-transform duration-300 ease-[var(--ease-soft)]",
                      left === 0 ? "bg-danger" : left <= 3 ? "bg-fire" : "bg-brand",
                    )}
                  />
                </div>

                <p className="mt-2.5 text-[13px] leading-relaxed text-text-2">
                  {left === 0
                    ? "На сегодня всё. Лимит обновится завтра — календарь и черновики работают как обычно."
                    : `Осталось ${left} ${plural(left, "генерация", "генерации", "генераций")} на сегодня.`}
                </p>
                <p className="mt-1 text-[13px] leading-relaxed text-text-3">
                  Лимит честный: ИИ стоит денег, а платформа бесплатная. Обновляется каждую ночь.
                </p>
              </Card>
            </div>
          </aside>
        </div>
      )}
    </AppShell>
  );
}

/**
 * useSearchParams() «выключает» пререндер всего дерева до ближайшей границы Suspense,
 * и next build падает, если её нет (в dev проверки нет — потому и не видели). Оборачиваем,
 * как велит документация этой версии Next: показываем тот же скелет, что и при загрузке.
 */
export default function StudioPage() {
  return (
    <Suspense
      fallback={
        <AppShell
          title="ИИ-студия"
          subtitle="Пиши как в чате. ИИ помнит твой стиль и опирается на разведку."
        >
          <StudioSkeleton />
        </AppShell>
      }
    >
      <StudioPageInner />
    </Suspense>
  );
}
