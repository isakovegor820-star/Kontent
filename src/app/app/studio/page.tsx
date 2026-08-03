"use client";

// А9. ИИ-студия (ТЗ 5.6, Приложение А).
// Диалог + быстрые команды. ИИ помнит стиль пользователя и следует настройкам платформы.
// Главное действие — сгенерировать и отправить в календарь.

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { motion, useReducedMotion } from "motion/react";
import {
  ArrowUp,
  Brain,
  CalendarRange,
  Check,
  Clapperboard,
  Copy,
  Cpu,
  FileText,
  ImageIcon,
  ListChecks,
  MessageSquareText,
  Pencil,
  Plus,
  RefreshCw,
  Settings2,
  Sparkles,
  Square,
  Video,
} from "lucide-react";

import { AppShell } from "@/components/app/shell";
import { Button } from "@/components/ui/button";
import { Card, Input, Textarea } from "@/components/ui/primitives";
import {
  MediaGenerator,
  type MediaGeneration,
  type MediaKind,
} from "@/components/studio/media-generator";
import { type AiCommand } from "@/lib/ai";
import type { AiRole, ConversationTurn } from "@/lib/ai-provider";
import { useStore } from "@/lib/store";
import type { RealChannel } from "@/lib/types";
import { cn, uid } from "@/lib/utils";

/* --------------------------------------------------------------- ОСНОВЫ */

type Msg = {
  id: string;
  role: "user" | "ai";
  text: string;
  streaming?: boolean;
  postable?: boolean;
};

/** Что ИИ должен «помнить» для перегенерации ответа */
type Gen = { cmd: AiCommand; input: string; variant: number; history: ConversationTurn[] };

type WorkspaceMode = "chat" | "studio";

const EASE_SOFT: [number, number, number, number] = [0.22, 1, 0.36, 1];

const ICON = "h-4 w-4";

type Quick = {
  id: string;
  label: string;
  icon: React.ReactNode;
  /** подставить заготовку в поле — человек дописывает тему сам */
  draft?: string;
  /** выполнить сразу, дописывать нечего */
  instant?: string;
  /** открыть настоящий генератор медиа, а не текстовый промпт */
  mediaKind?: MediaKind;
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
    mediaKind: "image",
  },
  {
    id: "video",
    label: "Создать рилс",
    icon: <Video className={ICON} strokeWidth={2} aria-hidden />,
    mediaKind: "video",
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

/** Короткая команда после готового ответа означает редактуру, а не новую тему поста. */
function looksLikeEditFollowUp(text: string): boolean {
  return /^(сделай|убери|добавь|замени|оставь|измени|поменяй|перестрой|давай|без|больше|меньше|ещё|слишком)\b/i.test(
    text.trim(),
  );
}

// Примеры для пустого диалога: показать, что тут вообще можно попросить, вместо голого поля.
// Нейтральные по нише — конкретика приедет из настроек и разведки, выдумывать её не надо.
/* ------------------------------------------------------------- СООБЩЕНИЕ */

function MessageRow({
  msg,
  reduce,
  onStop,
  onSchedule,
  onCopy,
  onRegenerate,
  onShorten,
}: {
  msg: Msg;
  reduce: boolean;
  onStop: () => void;
  onSchedule: () => void;
  onCopy: () => void;
  onRegenerate: () => void;
  onShorten: () => void;
}) {
  const appear = {
    initial: reduce ? false : { opacity: 0, y: 10 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.26, ease: EASE_SOFT },
  };

  // Пользователь — обычный текст справа, без пузыря и фоновой карточки.
  if (msg.role === "user") {
    return (
      <motion.div {...appear} className="ml-auto w-fit max-w-[min(88%,42rem)] shrink-0 text-right">
        <p className="mb-1 text-[11px] font-bold tracking-wide text-text-3 uppercase">Ты</p>
        <p className="text-[15px] leading-[1.65] whitespace-pre-wrap text-text">{msg.text}</p>
      </motion.div>
    );
  }

  const ready = !msg.streaming && msg.text.trim().length > 0;

  // ИИ — обычный читаемый текст без ещё одной карточки вокруг карточки.
  return (
    <motion.div {...appear} className="w-full shrink-0">
      <div className="min-w-0">
        <p className="mb-2 flex items-center gap-2 text-[11px] font-bold tracking-wide text-text-3 uppercase">
          <span className="h-1.5 w-1.5 rounded-full bg-success-text" aria-hidden />
          Аврора
        </p>
        <p
          className={cn(
            "max-w-[72ch] text-[15px] leading-[1.7] whitespace-pre-wrap text-text",
            msg.streaming && "caret",
          )}
        >
          {msg.text}
        </p>

        {/* Печатает — можно остановить. Анимация никогда не держит человека (ТЗ 7.4) */}
        {msg.streaming && (
          <div className="mt-2">
            <Button variant="ghost" size="sm" onClick={onStop}>
              <Square className="h-3 w-3" fill="currentColor" strokeWidth={2} aria-hidden />
              Стоп
            </Button>
          </div>
        )}

        {/* Готовый текст → открыть как пост и выбрать публикацию сразу или по расписанию */}
        {ready && msg.postable && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <Button variant="soft" size="sm" className="h-8 px-2.5 text-[12px]" onClick={onSchedule}>
              <FileText className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />В пост
            </Button>
            <Button variant="ghost" size="sm" className="h-8 px-2.5 text-[12px]" onClick={onCopy}>
              <Copy className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
              Скопировать
            </Button>
            <Button variant="ghost" size="sm" className="h-8 px-2.5 text-[12px]" onClick={onRegenerate}>
              <RefreshCw className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
              Ещё вариант
            </Button>
            <Button variant="ghost" size="sm" className="h-8 px-2.5 text-[12px]" onClick={onShorten}>
              Короче
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

/* ---------------------------------------------------- РЕЖИМЫ РАБОТЫ */

function WorkspaceModeSwitch({
  value,
  onChange,
}: {
  value: WorkspaceMode;
  onChange: (value: WorkspaceMode) => void;
}) {
  const modes: { id: WorkspaceMode; label: string; icon: React.ReactNode }[] = [
    {
      id: "chat",
      label: "Чат",
      icon: <MessageSquareText className="h-4 w-4" strokeWidth={2} aria-hidden />,
    },
    {
      id: "studio",
      label: "Студия",
      icon: <Sparkles className="h-4 w-4" strokeWidth={2} aria-hidden />,
    },
  ];

  return (
    <div
      role="tablist"
      aria-label="Режим ИИ-студии"
      className="inline-grid grid-cols-2 rounded-md border-2 border-line bg-surface p-1 shadow-[3px_3px_0_var(--ink)]"
    >
      {modes.map((mode) => (
        <button
          key={mode.id}
          type="button"
          role="tab"
          aria-selected={value === mode.id}
          aria-controls={`${mode.id}-workspace`}
          onClick={() => onChange(mode.id)}
          className={cn(
            "inline-flex min-h-10 items-center justify-center gap-2 rounded-xs px-4 text-[13px] font-extrabold transition-colors sm:min-w-[126px]",
            value === mode.id
              ? "bg-brand text-text"
              : "text-text-2 hover:bg-surface-2 hover:text-text",
          )}
        >
          {mode.icon}
          {mode.label}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------ ДВИЖОК ИИ */
// Выбор модели-агента. Облачные движки ждут свой ключ, а roadmap-адаптеры отключены.
// Если выбран движок без ключа, генерация честно откажет (см. /api/ai/generate) — тайком
// подменять модель мы не станем, иначе «выбор модели» превращается в декорацию.

interface EngineInfo {
  id: string;
  label: string;
  vendor: string;
  note: string;
  needs: string | null;
  ruFriendly: boolean;
  supported: boolean;
  recommended: boolean;
  status: "ready" | "no_key" | "offline";
  reason: string | null;
}

interface MoodInfo {
  key: string;
  label: string;
  emoji: string;
  description: string;
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

/** Все шаблоны спрятаны за одной кнопкой и не конкурируют с полем ввода. */
function QuickActionsMenu({
  items,
  onPick,
  disabled,
}: {
  items: Quick[];
  onPick: (item: Quick) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label="Открыть инструменты"
        className={cn(
          "grid h-9 w-9 shrink-0 cursor-pointer place-items-center rounded-full text-text-2",
          "transition-colors hover:bg-surface-2 hover:text-text disabled:pointer-events-none disabled:opacity-45",
          open && "bg-surface-2 text-text",
        )}
      >
        <Plus className="h-3.5 w-3.5" strokeWidth={2.25} aria-hidden />
      </button>

      <Popover open={open} onClose={() => setOpen(false)} className="w-[300px] p-2.5">
        <p className="px-2 pb-2 text-[11px] font-bold tracking-wide text-text-3 uppercase">
          Что создать
        </p>
        <div className="grid gap-1">
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                onPick(item);
                setOpen(false);
              }}
              className="flex min-h-11 w-full cursor-pointer items-center gap-3 rounded-sm px-3 text-left text-[13px] font-semibold text-text transition-colors hover:bg-surface-inset"
            >
              <span className="shrink-0 text-text-2">
                {item.icon}
              </span>
              {item.label}
            </button>
          ))}
        </div>
      </Popover>
    </div>
  );
}

function channelName(channel: RealChannel | undefined): string {
  return channel?.title || channel?.handle || (channel ? `Канал ${channel.id}` : "Нет канала");
}

/** Канал выбирается прямо у поля: профиль одного бренда никогда не смешивается с другим. */
function ChannelMenu({
  channels,
  value,
  onChange,
  disabled,
}: {
  channels: RealChannel[];
  value: number | null;
  onChange: (channelId: number) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const active = channels.find((channel) => channel.id === value);
  const label = channelName(active);

  return (
    <div className="relative min-w-0">
      <button
        type="button"
        disabled={disabled || channels.length === 0}
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-label={`Канал: ${label}`}
        className={cn(
          "inline-flex h-9 max-w-[180px] min-w-0 shrink cursor-pointer items-center gap-1.5 rounded-full px-2.5",
          "text-[12px] font-semibold text-text-2 transition-colors hover:bg-surface-2 hover:text-text",
          "disabled:pointer-events-none disabled:opacity-45",
          open && "bg-surface-2 text-text",
        )}
      >
        <MessageSquareText className="h-4 w-4 shrink-0" strokeWidth={2} aria-hidden />
        <span className="truncate">{label}</span>
      </button>

      <Popover open={open} onClose={() => setOpen(false)} className="w-[320px] p-3">
        <div className="px-1 pb-2">
          <p className="text-[14px] font-extrabold text-text">Для какого канала пишем?</p>
          <p className="mt-1 text-[11px] leading-relaxed text-text-3">
            Аврора возьмёт паспорт и примеры только этого канала.
          </p>
        </div>
        <div className="mt-1 grid gap-1">
          {channels.map((channel) => {
            const selected = channel.id === value;
            return (
              <button
                key={channel.id}
                type="button"
                aria-pressed={selected}
                onClick={() => {
                  onChange(channel.id);
                  setOpen(false);
                }}
                className={cn(
                  "flex min-h-12 w-full cursor-pointer items-center gap-3 rounded-sm px-3 py-2 text-left transition-colors",
                  selected ? "bg-info-soft" : "hover:bg-surface-inset",
                )}
              >
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-surface-inset text-[11px] font-black uppercase text-text-2">
                  {channel.network}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-bold text-text">
                    {channelName(channel)}
                  </span>
                  {channel.handle && channel.title && (
                    <span className="mt-0.5 block truncate text-[10px] text-text-3">{channel.handle}</span>
                  )}
                </span>
                {selected && <Check className="h-4 w-4 shrink-0 text-text" strokeWidth={2.5} aria-hidden />}
              </button>
            );
          })}
        </div>
      </Popover>
    </div>
  );
}

/** Настроение вынесено в composer: это ключевой редакторский выбор, а не скрытая технастройка. */
function MoodMenu({
  mood,
  moods,
  onMood,
  onLimit,
  saving,
  disabled,
}: {
  mood: string[];
  moods: MoodInfo[];
  onMood: (keys: string[]) => void;
  onLimit: () => void;
  saving: boolean;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const active = mood
    .map((key) => moods.find((item) => item.key === key))
    .filter((item): item is MoodInfo => Boolean(item));
  const activeLabel = active.map((item) => item.label).join(" + ") || "Экспертный";

  const toggle = (key: string) => {
    if (mood.includes(key)) {
      if (mood.length === 1) return;
      onMood(mood.filter((item) => item !== key));
      return;
    }
    if (mood.length >= 3) {
      onLimit();
      return;
    }
    onMood([...mood, key]);
  };

  return (
    <div className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label={`Настроение текста: ${activeLabel}`}
        className={cn(
          "inline-flex h-9 max-w-[240px] min-w-0 shrink cursor-pointer items-center gap-1.5 rounded-full px-2.5",
          "text-[12px] font-semibold text-text-2 transition-colors hover:bg-surface-2 hover:text-text",
          "disabled:pointer-events-none disabled:opacity-45",
          open && "bg-surface-2 text-text",
        )}
      >
        <Brain className="h-4 w-4 shrink-0" strokeWidth={2} aria-hidden />
        <span className="truncate">{activeLabel}</span>
      </button>

      <Popover open={open} onClose={() => setOpen(false)} className="w-[390px] p-3">
        <div className="px-1 pb-2">
          <div className="flex items-center justify-between gap-3">
            <p className="text-[14px] font-extrabold text-text">Как должен звучать пост?</p>
            <span className="shrink-0 rounded-full bg-surface-inset px-2 py-1 text-[10px] font-bold text-text-2">
              {saving ? "Сохраняю…" : `Выбрано ${mood.length}/3`}
            </span>
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-text-3">
            Соедини до трёх профилей. Аврора смешает их ритм, лексику и силу позиции, сохранив факты и ограничения.
          </p>
        </div>

        <div className="mt-1 grid gap-1">
          {moods.map((item) => {
            const selected = mood.includes(item.key);
            const blocked = !selected && mood.length >= 3;
            return (
              <button
                key={item.key}
                type="button"
                disabled={saving}
                aria-pressed={selected}
                aria-disabled={blocked}
                onClick={() => toggle(item.key)}
                className={cn(
                  "flex min-h-[58px] w-full cursor-pointer items-center gap-3 rounded-sm px-3 py-2 text-left transition-colors",
                  selected ? "bg-info-soft" : "hover:bg-surface-inset",
                  blocked && "opacity-45",
                  saving && "cursor-wait",
                )}
              >
                <span className="text-[18px]" aria-hidden>{item.emoji}</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-bold text-text">{item.label}</span>
                  <span className="mt-0.5 block text-[11px] leading-snug text-text-3">
                    {item.description}
                  </span>
                </span>
                <span
                  className={cn(
                    "grid h-5 w-5 shrink-0 place-items-center rounded-full",
                    selected ? "bg-brand text-text" : "border border-line",
                  )}
                  aria-hidden
                >
                  {selected && <Check className="h-3.5 w-3.5" strokeWidth={2.5} />}
                </span>
              </button>
            );
          })}
        </div>

        <p className="mt-2 border-t border-line px-1 pt-2 text-[10px] leading-relaxed text-text-3">
          Должен остаться хотя бы один профиль. Связка сохраняется для следующих генераций Авроры.
        </p>
      </Popover>
    </div>
  );
}

/** Вторичные параметры живут за одной иконкой, чтобы сам чат оставался чистым. */
function ChatSettingsMenu({
  engines,
  current,
  onPick,
  loading,
  role,
  onRole,
  niche,
  tone,
  onNiche,
  onTone,
  publishedSamples,
  left,
  limit,
}: {
  engines: EngineInfo[];
  current: string | null;
  onPick: (engine: EngineInfo) => void;
  loading: boolean;
  role: AiRole | null;
  onRole: (role: AiRole | null) => void;
  niche: string;
  tone: string;
  onNiche: (v: string) => void;
  onTone: (v: string) => void;
  publishedSamples: number;
  left: number;
  limit: number;
}) {
  const [open, setOpen] = useState(false);
  const activeEngine = engines.find((engine) => engine.id === current);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label="Настройки чата"
        className={cn(
          "grid h-9 w-9 shrink-0 cursor-pointer place-items-center rounded-full text-text-2 transition-colors hover:bg-surface-2 hover:text-text",
          open && "bg-surface-2 text-text",
        )}
      >
        <Settings2 className="h-[17px] w-[17px]" strokeWidth={2} aria-hidden />
      </button>

      <Popover open={open} onClose={() => setOpen(false)} className="w-[380px] p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[14px] font-extrabold text-text">Точная настройка</p>
            <p className="mt-0.5 text-[11px] text-text-3">
              {publishedSamples}/10 постов в контексте · {left} из {limit} генераций осталось
            </p>
          </div>
          <span className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", engineDot(activeEngine?.status ?? "no_key"))} aria-hidden />
        </div>

        <div className="mt-4 border-t border-line pt-3">
          <p className="flex items-center gap-1.5 text-[12px] font-semibold text-text-3">
            <Cpu className="h-3.5 w-3.5" aria-hidden /> Модель
          </p>
          <div className="mt-2 grid gap-1">
            {loading ? (
              <div className="skeleton h-10 w-full" />
            ) : (
              engines.map((engine) => (
                <button
                  key={engine.id}
                  type="button"
                  disabled={!engine.supported}
                  aria-pressed={engine.id === current}
                  onClick={() => onPick(engine)}
                  className={cn(
                    "flex min-h-10 w-full cursor-pointer items-center gap-2 rounded-xs px-2.5 text-left transition-colors",
                    engine.id === current ? "bg-info-soft" : "hover:bg-surface-inset",
                    !engine.supported && "cursor-not-allowed opacity-50",
                  )}
                >
                  <span className={cn("h-2 w-2 shrink-0 rounded-full", engineDot(engine.status))} aria-hidden />
                  <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-text">{engine.label}</span>
                  <span className="text-[10px] text-text-3">{engine.vendor}</span>
                </button>
              ))
            )}
          </div>
        </div>

        <div className="mt-3 border-t border-line pt-3">
          <p className="text-[12px] font-semibold text-text-3">Роль</p>
          <div className="mt-2 grid grid-cols-2 gap-1.5">
            {([null, "copywriter", "strategist", "critic"] as const).map((item) => (
              <button
                key={item ?? "default"}
                type="button"
                onClick={() => onRole(item)}
                aria-pressed={role === item}
                className={cn(
                  "min-h-9 rounded-xs border px-2.5 text-[12px] font-semibold transition-colors",
                  role === item
                    ? "border-brand bg-info-soft text-info-text"
                    : "border-line bg-surface text-text-2 hover:border-line-strong hover:text-text",
                )}
              >
                {item === null
                  ? "Универсальный"
                  : item === "copywriter"
                    ? "Копирайтер"
                    : item === "strategist"
                      ? "Стратег"
                      : "Критик"}
              </button>
            ))}
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-text-3">
            {role === "copywriter"
              ? "Сильный хук, структура и CTA."
              : role === "strategist"
                ? "Рубрики, идеи и системный контент-план."
                : role === "critic"
                  ? "Честный разбор слабых мест и конкретные правки."
                  : "Подходит для большинства задач."}
          </p>
        </div>

        <div className="mt-3 flex flex-col gap-2 border-t border-line pt-3">
          <EditableRow label="Ниша" value={niche} onSave={onNiche} />
          <EditableRow label="Голос автора" value={tone} onSave={onTone} />
        </div>

        <p className="mt-3 border-t border-line pt-2 text-[11px] leading-relaxed text-text-3">
          Модель получает только текущую задачу, настройки профиля и твои опубликованные посты как образец голоса.
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

  const [messages, setMessages] = useState<Msg[]>([]);
  const [draft, setDraft] = useState("");
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>("chat");
  const [mediaKind, setMediaKind] = useState<MediaKind>("image");
  const [pickedChannelId, setPickedChannelId] = useState<number | null>(null);
  // Роль ИИ: модифицирует системный промпт (копирайтер / стратег / критик).
  const [role, setRole] = useState<AiRole | null>(null);
  // Настроение агента (одно на аккаунт, из БД) — влияет на всю генерацию.
  const [mood, setMood] = useState<string[]>(["expert"]);
  const [moods, setMoods] = useState<MoodInfo[]>([]);
  const [moodSaving, setMoodSaving] = useState(false);

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
  const activeChannels = s.realChannels.filter((channel) => channel.is_active);
  const channelId =
    pickedChannelId && activeChannels.some((channel) => channel.id === pickedChannelId)
      ? pickedChannelId
      : (activeChannels[0]?.id ?? null);

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

  // Поле растёт вместе с сообщением до разумного предела, затем прокручивается внутри.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [draft]);

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
        setMood(Array.isArray(d.mood) ? d.mood : [d.mood ?? "expert"]);
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

  // После возвращения из Студии чат снова подгоняется под доступную высоту экрана.
  useEffect(() => {
    if (workspaceMode !== "chat") return;
    const frame = requestAnimationFrame(fit);
    return () => cancelAnimationFrame(frame);
  }, [fit, workspaceMode]);

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
    if (!e.supported) return;
    const response = await fetch("/api/ai/engines", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ engine: e.id }),
    }).catch(() => null);
    if (!response?.ok) {
      s.toast({ kind: "danger", title: "Не удалось сменить движок", body: "Попробуй ещё раз." });
      return;
    }
    setEngine(e.id);
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

  const pickMood = async (keys: string[]) => {
    if (moodSaving) return;
    const previous = mood;
    setMood(keys);
    setMoodSaving(true);
    const response = await fetch("/api/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mood: keys }),
    }).catch(() => null);
    if (!response?.ok) {
      setMood(previous);
      s.toast({
        kind: "danger",
        title: "Не удалось сохранить настроение",
        body: "Попробуй выбрать профиль ещё раз.",
      });
      setMoodSaving(false);
      return;
    }
    const labels = keys
      .map((key) => moods.find((item) => item.key === key)?.label)
      .filter(Boolean)
      .join(" + ");
    s.toast({
      kind: "success",
      title: `Связка: ${labels}`,
      body: "Аврора объединит выбранные свойства в следующих текстах.",
    });
    setMoodSaving(false);
  };

  const moodLimitToast = () =>
    s.toast({
      kind: "info",
      title: "Максимум три профиля",
      body: "Сними один из выбранных профилей, чтобы добавить другой.",
    });

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
          channelId,
          history: gen.history,
          // Сервер включает строгий режим: текущая задача + настройки + опубликованные посты.
          // Контент конкурентов и внешние сведения в ИИ-студию не попадают.
          surface: "studio",
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
            info?.error === "engine_unsupported"
              ? `Ты выбрал ${info.label}, но интеграция с этим движком пока не готова. ` +
                `Выбери в «Движке» Ollama, OpenAI, Claude или Gemini.`
              : info?.error === "engine_not_connected"
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

    const history: ConversationTurn[] = messages
      .filter((message) => message.text.trim() && !message.streaming)
      .map((message) => ({
        role: message.role === "ai" ? ("assistant" as const) : ("user" as const),
        content: message.text,
      }))
      .slice(-8);
    const hasAnswer = history.some((turn) => turn.role === "assistant");
    const detected = opts?.cmd ?? pickCommand(text);
    const cmd = !opts?.cmd && detected === "write" && hasAnswer && looksLikeEditFollowUp(text)
      ? "rewrite"
      : detected;
    const gen: Gen = { cmd, input: opts?.input ?? text, variant: 0, history };
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

  const putInComposer = (text: string) => {
    setDraft(text);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus({ preventScroll: true });
      el.setSelectionRange(el.value.length, el.value.length);
    });
  };

  const onQuick = (q: Quick) => {
    if (busy) return;

    if (q.mediaKind) {
      setMediaKind(q.mediaKind);
      setWorkspaceMode("studio");
      return;
    }

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
      putInComposer(q.draft);
    }
  };

  const useGeneratedMedia = (generation: MediaGeneration) => {
    if (!generation.assetId || !generation.assetUrl) return;
    sessionStorage.setItem(
      "aurora:generated-media",
      JSON.stringify({
        kind: generation.kind,
        label: generation.kind === "video" ? `Рилс ${generation.seconds ?? 6} сек.` : `Изображение ${generation.aspectRatio}`,
        hue: generation.kind === "video" ? 42 : 48,
        assetId: generation.assetId,
        url: generation.assetUrl,
        mimeType: generation.mimeType,
      }),
    );
    router.push("/app/composer?fromMedia=1");
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    ask(draft);
  };

  /* ---------------------------------------------------------- РАБОЧАЯ ЗОНА */

  const publishedSamples = Math.min(
    10,
    s.realPosts.filter(
      (post) =>
        post.channel_id === channelId &&
        post.status === "published" &&
        post.text.trim().length > 0,
    ).length,
  );

  const changeWorkspace = (next: WorkspaceMode) => {
    setWorkspaceMode(next);
  };

  return (
    <AppShell
      title="ИИ-студия"
      subtitle={
        workspaceMode === "chat"
          ? "Обсуждай идеи и создавай тексты в обычном диалоге."
          : "Создавай изображения и видео в отдельном рабочем пространстве."
      }
      action={<WorkspaceModeSwitch value={workspaceMode} onChange={changeWorkspace} />}
    >
      {!s.ready ? (
        <StudioSkeleton />
      ) : (
        <>
          {/* Чат и Студия остаются смонтированы: можно переключаться
              между ними, не теряя черновик сообщения или настройки генерации медиа. */}
          <div
            id="chat-workspace"
            role="tabpanel"
            aria-label="Режим Чат"
            ref={attachShell}
            className={cn(
              "mx-auto h-[var(--studio-h)] w-full max-w-[1180px]",
              workspaceMode === "chat" ? "flex" : "hidden",
            )}
          >
            {/* min-h-0 обязателен: лента сжимается и прокручивается внутри, а поле ввода
                остаётся закреплённым внизу рабочей области. */}
            <section aria-label="Диалог с ИИ" className="flex min-h-0 min-w-0 flex-1 flex-col">
              {/* Одна прокрутка для всей истории; сам текст держим в комфортной ширине. */}
              <div ref={feedRef} className="min-h-0 flex-1 overflow-y-auto">
                <div
                  className={cn(
                    "mx-auto flex min-h-full w-full max-w-[820px] flex-col px-4 py-6 md:px-6 md:py-8",
                    messages.length > 0 ? "gap-7" : "justify-center",
                  )}
                >
                  {messages.map((message) => (
                    <MessageRow
                      key={message.id}
                      msg={message}
                      reduce={reduce}
                      onStop={stop}
                      onSchedule={() => schedule(message.text)}
                      onCopy={() => void copy(message.text)}
                      onRegenerate={() => regenerate(message.id)}
                      onShorten={() => ask("Сделай короче")}
                    />
                  ))}

                  {messages.length === 0 && (
                    <div className="flex flex-1 flex-col items-center justify-center pb-20 text-center">
                      <h2 className="text-[22px] font-semibold tracking-tight text-text-2">
                        Чем помочь?
                      </h2>
                      <p className="mt-2 text-[14px] text-text-3">
                        Напиши задачу — ответ появится здесь.
                      </p>
                    </div>
                  )}

                  <div ref={endRef} className="h-px shrink-0" aria-hidden />
                </div>
              </div>

              {/* Единый composer: текст сверху, все вторичные действия — в одной строке снизу. */}
              <div className="shrink-0 px-3 pb-3 md:px-5 md:pb-4">
                <div className="mx-auto w-full max-w-[820px] rounded-[24px] border border-line/70 bg-surface shadow-[0_12px_40px_rgb(17_17_17/0.10)] transition-shadow focus-within:shadow-[0_14px_44px_rgb(17_17_17/0.14)] focus-within:ring-2 focus-within:ring-brand/15">
                  <Textarea
                    ref={inputRef}
                    data-chat-composer
                    rows={1}
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={onKeyDown}
                    aria-label="Что написать ИИ"
                    placeholder="Напиши сообщение Авроре…"
                    className="min-h-[64px] max-h-[180px] overflow-y-auto rounded-t-[24px] border-0 bg-transparent px-5 pt-4 pb-2 text-[16px] leading-relaxed hover:border-0 focus:border-0 focus-visible:ring-0"
                  />

                  <div className="flex min-w-0 items-center gap-1 px-3 pb-3">
                    <QuickActionsMenu items={QUICK} onPick={onQuick} disabled={busy} />
                    <ChannelMenu
                      channels={activeChannels}
                      value={channelId}
                      onChange={setPickedChannelId}
                      disabled={busy}
                    />
                    <MoodMenu
                      mood={mood}
                      moods={moods}
                      onMood={pickMood}
                      onLimit={moodLimitToast}
                      saving={moodSaving}
                      disabled={busy}
                    />
                    <ChatSettingsMenu
                      engines={engines}
                      current={engine}
                      onPick={pickEngine}
                      loading={enginesLoading}
                      role={role}
                      onRole={setRole}
                      niche={s.settings.niche}
                      tone={s.settings.tone}
                      onNiche={(value) => {
                        s.updateSettings({ niche: value });
                        s.toast({ kind: "info", title: "Запомнил", body: "Следующие тексты будут ближе к этой теме." });
                      }}
                      onTone={(value) => {
                        s.updateSettings({ tone: value });
                        s.toast({ kind: "info", title: "Запомнил", body: "Следующие тексты будут звучать так." });
                      }}
                      publishedSamples={publishedSamples}
                      left={left}
                      limit={limit}
                    />

                    <Button
                      variant="brand"
                      size="icon"
                      className="ml-auto h-10 w-10 shrink-0 rounded-full"
                      aria-label="Отправить"
                      disabled={busy || draft.trim().length === 0}
                      onClick={() => ask(draft)}
                    >
                      <ArrowUp className="h-[18px] w-[18px]" strokeWidth={2.5} aria-hidden />
                    </Button>
                  </div>
                </div>
              </div>
            </section>
          </div>

          <div
            id="studio-workspace"
            role="tabpanel"
            aria-label="Режим Студия"
            className={cn(
              "mx-auto w-full max-w-[1180px]",
              workspaceMode === "studio" ? "block" : "hidden",
            )}
          >
            <MediaGenerator
              key={mediaKind}
              initialKind={mediaKind}
              niche={s.settings.niche}
              tone={s.settings.tone}
              onClose={() => setWorkspaceMode("chat")}
              onUse={useGeneratedMedia}
            />
          </div>
        </>
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
          subtitle="Пиши как в чате. Модель использует только твои посты и настройки Авроры."
        >
          <StudioSkeleton />
        </AppShell>
      }
    >
      <StudioPageInner />
    </Suspense>
  );
}
