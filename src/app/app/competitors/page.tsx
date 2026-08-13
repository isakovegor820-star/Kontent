"use client";

// А6. КОНКУРЕНТЫ (ТЗ 5.4, Д.6). Настоящие досье по открытым данным Telegram-каналов:
// добавляешь ссылку → воркер собирает статистику постов (t.me/s/ + Bot API). Лимит 20,
// свободно добавлять/удалять. Словесные выводы ИИ подключим отдельно (пока — честная статистика).

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  Activity,
  ArrowRight,
  Clock3,
  ExternalLink,
  Eye,
  FileText,
  Loader2,
  Plus,
  Radar,
  Sparkles,
  Trash2,
  TriangleAlert,
  Users,
  X,
} from "lucide-react";

import { AppShell } from "@/components/app/shell";
import { ChannelPicker, useChannelChoice } from "@/components/app/channel-picker";
import { Button } from "@/components/ui/button";
import { Badge, Card, EmptyState, Field, GlassCard, Input, TelegramIcon } from "@/components/ui/primitives";
import { useStore } from "@/lib/store";
import { cn, fmtCompact, fmtNum, plural } from "@/lib/utils";

const EASE = [0.22, 1, 0.36, 1] as const;
const MAX = 20;

interface Competitor {
  id: number | string;
  handle: string;
  title: string | null;
  subscribers: number | null;
  // no_feed — канал отвечает, но ленту публично не показывает: досье собрать не из чего.
  status: "pending" | "ready" | "error" | "no_feed";
  last_error: string | null;
  posts_count: number;
  avg_views: number | null;
  median_views?: number | null;
  hits_count?: number;
  thin_data?: boolean; // данных мало — цифрам верить нельзя
  /** Добавлен разведкой на холодном старте, а не человеком. Обязан быть виден. */
  auto_added?: boolean;
}

function addErrorText(error?: string, limit = MAX): string {
  switch (error) {
    case "empty":
      return "Вставь ссылку на Telegram-канал — например, t.me/durov или @durov.";
    case "private":
      return "Это приватная ссылка. Досье собирается только по публичным каналам.";
    case "bad":
      return "Не похоже на адрес канала. Нужен t.me/имя_канала или @имя_канала.";
    case "duplicate":
      return "Этот канал уже в списке.";
    case "limit":
      return `Лимит — ${limit} конкурентов. Удали кого-то, чтобы добавить нового.`;
    default:
      return "Не получилось добавить. Попробуй ещё раз.";
  }
}

/* --------------------------------------------------------------- КАРТОЧКА */

function CompetitorCard({
  c,
  confirming,
  onAskDelete,
  onCancelDelete,
  onDelete,
}: {
  c: Competitor;
  confirming: boolean;
  onAskDelete: () => void;
  onCancelDelete: () => void;
  onDelete: () => void;
}) {
  return (
    <Card className="relative flex h-full flex-col p-5">
      {/* Удаление — свободно (анти-урок Metricool). Поверх ссылки, не открывает досье. */}
      {confirming ? (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 rounded-[inherit] bg-surface/95 p-5 text-center backdrop-blur-sm">
          <p className="text-[14px] font-semibold text-text">Удалить «{c.title || "@" + c.handle}»?</p>
          <div className="flex gap-2">
            <Button size="sm" variant="danger" onClick={onDelete}>
              Удалить
            </Button>
            <Button size="sm" variant="ghost" onClick={onCancelDelete}>
              Отмена
            </Button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={onAskDelete}
          aria-label="Удалить конкурента"
          className="absolute top-3 right-3 z-10 flex h-8 w-8 cursor-pointer items-center justify-center rounded-full text-text-3 transition-colors hover:bg-surface-inset hover:text-danger"
        >
          <Trash2 className="h-4 w-4" strokeWidth={2} aria-hidden />
        </button>
      )}

      <Link href={`/app/competitors/${c.id}`} className="flex flex-1 flex-col">
        <div className="flex items-center gap-2 text-text-3">
          <TelegramIcon className="h-4 w-4" />
          <span className="truncate text-[13px] font-semibold">@{c.handle}</span>
        </div>
        <h2 className="mt-1.5 line-clamp-2 pr-8 text-[17px] leading-snug font-bold text-text">
          {c.title || "@" + c.handle}
        </h2>

        {/* Автоматика обязана быть подписана. Человек должен понимать, откуда взялся канал,
            которого он не добавлял, — иначе это сюрприз, а не помощь. */}
        {c.auto_added && (
          <span className="mt-2 inline-flex w-fit items-center gap-1.5 rounded-full bg-info-soft px-2 py-1 text-[13px] leading-none font-semibold text-info-text">
            <Sparkles className="h-3 w-3 shrink-0" strokeWidth={2.5} aria-hidden />
            нашла разведка
          </span>
        )}

        {c.status === "pending" ? (
          <p className="mt-4 inline-flex items-center gap-2 text-[14px] text-text-2">
            <Loader2 className="h-4 w-4 animate-spin text-brand" aria-hidden />
            Собираем досье…
          </p>
        ) : c.status === "error" || c.status === "no_feed" ? (
          <p className="mt-4 inline-flex items-start gap-2 text-[13px] leading-snug text-danger-text">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            {c.last_error || "Не удалось собрать — проверь, что канал публичный."}
          </p>
        ) : (
          <>
            <div className="mt-4 grid grid-cols-2 gap-3">
              <div>
                <p className="flex items-center gap-1.5 text-[12px] font-semibold text-text-3">
                  <Users className="h-3.5 w-3.5" aria-hidden />
                  Подписчики
                </p>
                <p className="nums mt-0.5 text-[20px] leading-none font-extrabold text-text">
                  {c.subscribers != null ? fmtCompact(c.subscribers) : "—"}
                </p>
              </div>
              <div>
                <p className="flex items-center gap-1.5 text-[12px] font-semibold text-text-3">
                  <Eye className="h-3.5 w-3.5" aria-hidden />
                  Ср. просмотры
                </p>
                <p className="nums mt-0.5 text-[20px] leading-none font-extrabold text-text">
                  {c.avg_views != null ? fmtCompact(c.avg_views) : "—"}
                </p>
              </div>
            </div>

            {/* Честность: на мелкой выборке цифры выше — шум. Не даём принять их за правду. */}
            {c.thin_data && (
              <p className="mt-3 inline-flex items-start gap-1.5 rounded-md bg-surface-inset px-2 py-1.5 text-[12px] leading-snug text-text-3">
                <TriangleAlert className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
                Данных мало — выводам верить рано
              </p>
            )}
          </>
        )}

        <div className="mt-auto flex items-center justify-between gap-2 pt-4">
          <span className="text-[13px] text-text-3">
            {c.status === "ready" ? `${fmtNum(c.posts_count)} ${plural(c.posts_count, "пост", "поста", "постов")} собрано` : " "}
          </span>
          <span className="flex items-center gap-1.5">
            {c.status === "ready" && !!c.hits_count && <Badge tone="fire">🔥 {c.hits_count}</Badge>}
            {c.status === "ready" && <Badge tone="neutral">Досье →</Badge>}
          </span>
        </div>
      </Link>
    </Card>
  );
}

/* -------------------------------------------------- НАХОДКИ АГЕНТА (Д.6+) */
/**
 * «Похоже, это твои соседи». Агент идёт по графу ниши — каналы ссылаются друг на друга в
 * постах — проверяет каждого кандидата живьём и приносит сюда. Добавляет ЧЕЛОВЕК: агент,
 * который молча набивает список, через неделю собирает досье не на тех.
 * Показываем, кто именно сослался: это обоснование, а не «доверься алгоритму».
 */
interface Suggestion {
  id: number;
  handle: string;
  title: string | null;
  description: string | null;
  subscribers: number | null;
  posts: number;
  lastPostAt: string | null;
  postsPerWeek: number | null;
  mentionedBy: number;
  sources: string[];
  /** true — ИИ сверил посты кандидата с твоим брифом; null — движка не было, не судили */
  onTopic: boolean | null;
  link: string;
}

function postingRateLabel(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "Недостаточно данных";
  const rate = value.toLocaleString("ru-RU", { maximumFractionDigits: 1 });
  return `≈ ${rate} ${plural(Math.round(value), "пост", "поста", "постов")}/нед.`;
}

function lastPostLabel(value: string | null): string {
  if (!value) return "Дата не найдена";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "Дата не найдена";
  const days = Math.max(0, Math.floor((Date.now() - timestamp) / 86_400_000));
  if (days === 0) return "Сегодня";
  if (days === 1) return "Вчера";
  if (days <= 30) return `${days} ${plural(days, "день", "дня", "дней")} назад`;
  return new Date(timestamp).toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
}

function SuggestionPreviewDialog({
  item,
  atLimit,
  fallbackFocusRef,
  onClose,
  onAdd,
  onDismiss,
}: {
  item: Suggestion;
  atLimit: boolean;
  fallbackFocusRef: React.RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onAdd: () => void;
  onDismiss: () => void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const overlayRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const fallbackFocus = fallbackFocusRef.current;
    previousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const overlay = overlayRef.current;
    const inerted = Array.from(document.body.children)
      .filter((element): element is HTMLElement => element instanceof HTMLElement && element !== overlay)
      .map((element) => ({ element, wasInert: element.inert }));
    inerted.forEach(({ element }) => {
      element.inert = true;
    });
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const frame = requestAnimationFrame(() => closeRef.current?.focus());

    return () => {
      cancelAnimationFrame(frame);
      document.body.style.overflow = previousOverflow;
      inerted.forEach(({ element, wasInert }) => {
        element.inert = wasInert;
      });
      const previous = previousFocusRef.current;
      if (previous?.isConnected) previous.focus();
      else fallbackFocus?.focus();
    };
  }, [fallbackFocusRef, item.id]);

  const dialog = (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-[110] grid place-items-center bg-black/45 p-3 sm:p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        className="max-h-[calc(100dvh-1.5rem)] w-full max-w-2xl overflow-y-auto overscroll-contain rounded-lg border border-line bg-surface p-5 shadow-float sm:max-h-[calc(100dvh-3rem)] sm:p-6"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
            return;
          }
          if (event.key !== "Tab") return;
          const focusable = Array.from(
            panelRef.current?.querySelectorAll<HTMLElement>(
              'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
            ) ?? [],
          ).filter((element) => !element.hasAttribute("disabled"));
          if (focusable.length === 0) {
            event.preventDefault();
            panelRef.current?.focus();
            return;
          }
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          const active = document.activeElement;
          if (event.shiftKey && (active === first || !panelRef.current?.contains(active))) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && (active === last || !panelRef.current?.contains(active))) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        <div className="flex items-start gap-3">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-info-soft text-info-text">
            <TelegramIcon className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-semibold text-text-3">@{item.handle}</p>
            <h2 id={titleId} className="mt-0.5 text-balance text-[20px] leading-tight font-extrabold text-text">
              {item.title || `@${item.handle}`}
            </h2>
            <p id={descriptionId} className="mt-1.5 text-[13px] leading-relaxed text-text-2">
              Проверь канал по открытым данным Telegram перед добавлением в конкуренты.
            </p>
          </div>
          <Button ref={closeRef} type="button" size="icon" variant="ghost" onClick={onClose} aria-label="Закрыть сводку">
            <X className="h-5 w-5" aria-hidden />
          </Button>
        </div>

        <dl className="mt-5 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          {[
            {
              label: "Подписчики",
              value: item.subscribers == null ? "—" : fmtCompact(item.subscribers),
              icon: Users,
            },
            { label: "Недавний темп", value: postingRateLabel(item.postsPerWeek), icon: Activity },
            { label: "Посты в выборке", value: fmtNum(item.posts), icon: FileText },
            { label: "Последний пост", value: lastPostLabel(item.lastPostAt), icon: Clock3 },
          ].map((metric) => {
            const Icon = metric.icon;
            return (
              <div key={metric.label} className="rounded-sm bg-surface-inset p-3">
                <dt className="flex items-center gap-1.5 text-[12px] font-semibold text-text-3">
                  <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  {metric.label}
                </dt>
                <dd className="nums mt-1 text-[15px] leading-snug font-extrabold text-text">
                  {metric.value}
                </dd>
              </div>
            );
          })}
        </dl>
        <p className="mt-2 text-[12px] leading-relaxed text-text-3">
          Темп рассчитан по интервалам между последними публичными постами.
        </p>

        <section className="mt-5" aria-labelledby={`${titleId}-about`}>
          <h3 id={`${titleId}-about`} className="text-[13px] font-bold text-text">О канале</h3>
          <p className="mt-1.5 whitespace-pre-line break-words text-pretty text-[14px] leading-relaxed text-text-2">
            {item.description || "Публичное описание Telegram пока недоступно."}
          </p>
        </section>

        <section className="mt-5" aria-labelledby={`${titleId}-reason`}>
          <h3 id={`${titleId}-reason`} className="text-[13px] font-bold text-text">Почему показали</h3>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {item.onTopic === true ? (
              <Badge tone="success">совпадает с твоей темой</Badge>
            ) : (
              <Badge tone="neutral">тема ещё не проверена</Badge>
            )}
            {item.mentionedBy > 1 && <Badge tone="brand">{item.mentionedBy} независимые ссылки</Badge>}
          </div>
          <p className="mt-2 text-[13px] leading-relaxed text-text-2">
            {item.sources.length > 0
              ? `На канал ссылаются: ${item.sources.map((source) => `@${source}`).join(", ")}.`
              : "Канал найден в справочнике платформы и проверен по открытой ленте."}
          </p>
        </section>

        {atLimit && (
          <p className="mt-5 rounded-sm bg-info-soft p-3 text-[13px] leading-relaxed text-info-text">
            Достигнут лимит конкурентов. Удали один канал из списка, чтобы добавить новый.
          </p>
        )}

        <div className="mt-6 flex flex-wrap items-center justify-end gap-2">
          <a
            href={item.link}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-[10px] border border-line-strong bg-surface px-3.5 py-2 text-[13px] font-semibold whitespace-nowrap text-text transition-[background-color,border-color,transform] duration-200 hover:bg-surface-inset active:scale-[0.96] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
            aria-label={`Открыть канал «${item.title || `@${item.handle}`}» в Telegram`}
          >
            Открыть канал
            <ExternalLink className="h-3.5 w-3.5" aria-hidden />
          </a>
          <Button type="button" variant="ghost" onClick={onDismiss}>
            Не подходит
          </Button>
          <Button type="button" variant="solid" onClick={onAdd} disabled={atLimit}>
            <Plus className="h-4 w-4" aria-hidden />
            Добавить конкурента
          </Button>
        </div>
      </div>
    </div>
  );

  return createPortal(dialog, document.body);
}

function Suggestions({
  onAdded,
  atLimit,
  channelId,
}: {
  onAdded: () => void;
  atLimit: boolean;
  channelId: number | null;
}) {
  const s = useStore();
  const [items, setItems] = useState<Suggestion[]>([]);
  const [seeds, setSeeds] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<Suggestion | null>(null);
  const searchButtonRef = useRef<HTMLButtonElement>(null);

  // Находки ищутся соседям КОНКРЕТНОГО канала — значит и показывать надо его находки.
  const load = useCallback(async () => {
    if (!channelId) {
      setLoadError(false);
      setLoading(false);
      return;
    }
    try {
      const r = await fetch(`/api/competitors/suggestions?channel=${channelId}`, {
        cache: "no-store",
      });
      if (!r.ok) throw new Error("suggestions_unavailable");
      const d = (await r.json()) as { suggestions?: Suggestion[]; seeds?: number };
      setItems(d.suggestions ?? []);
      setSeeds(d.seeds ?? 0);
      setLoadError(false);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [channelId]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- загрузка находок при монтировании
    load();
  }, [load]);

  const search = async () => {
    setBusy(true);
    try {
      await fetch(`/api/competitors/suggestions?channel=${channelId}`, { method: "POST" });
      s.toast({
        kind: "info",
        title: "Ищу соседей",
        body: "Читаю, на кого ссылаются каналы твоей ниши. Займёт минуту.",
      });
      setTimeout(load, 12_000);
      setTimeout(load, 30_000);
    } finally {
      setBusy(false);
    }
  };

  const act = async (it: Suggestion, action: "add" | "dismiss") => {
    setPreview(null);
    setItems((prev) => prev.filter((x) => x.id !== it.id)); // убираем сразу — ждать нечего
    const r = await fetch("/api/competitors/suggestions", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: it.id, action }),
    }).catch(() => null);
    const d = (await r?.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
    if (action === "add") {
      if (d?.error === "limit") {
        s.toast({ kind: "info", title: "Достигнут лимит", body: "Удали кого-нибудь из списка, чтобы добавить нового." });
        load();
        return;
      }
      s.toast({ kind: "success", title: `@${it.handle} добавлен`, body: "Собираю досье — цифры появятся через минуту." });
      onAdded();
    }
  };

  if (loading) return null;

  if (loadError && !items.length) {
    return (
      <Card className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-3 p-4" role="status">
        <TriangleAlert className="h-[18px] w-[18px] shrink-0 text-danger-text" strokeWidth={2} aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-[14px] font-semibold text-text">Не удалось загрузить похожие каналы</p>
          <p className="mt-0.5 text-[13px] leading-relaxed text-text-2">
            Рекомендации сохранены. Проверь соединение с сервером и попробуй снова.
          </p>
        </div>
        <Button size="sm" variant="soft" onClick={load}>
          Повторить
        </Button>
      </Card>
    );
  }

  // Графа нет без семени: не от чего идти — так и говорим, а не крутим пустой спиннер.
  if (!items.length && seeds === 0) return null;

  if (!items.length) {
    return (
      <Card className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-3 p-4">
        <Radar className="h-[18px] w-[18px] shrink-0 text-brand" strokeWidth={2} aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-[14px] font-semibold text-text">Найти соседей по нише</p>
          <p className="mt-0.5 text-[13px] leading-relaxed text-text-2">
            Посмотрю, на кого ссылаются твой канал и твои конкуренты. У Telegram нет поиска
            каналов — но соседи по нише ссылаются друг на друга, и это видно.
          </p>
        </div>
        <Button size="sm" variant="soft" onClick={search} loading={busy}>
          Найти
        </Button>
      </Card>
    );
  }

  return (
    <Card className="mb-6 p-5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Radar className="h-[18px] w-[18px] text-brand" strokeWidth={2} aria-hidden />
        <h2 className="text-[15px] font-extrabold tracking-tight text-text">
          Похоже, это твои соседи
        </h2>
        <span className="text-[13px] text-text-3">нашёл {items.length}</span>
        <Button ref={searchButtonRef} size="sm" variant="ghost" onClick={search} loading={busy} className="ml-auto">
          Искать ещё
        </Button>
      </div>

      <ul className="mt-4 grid gap-2.5 lg:grid-cols-2">
        {items.map((it) => (
          <li key={it.id} className="h-full">
            <button
              type="button"
              aria-haspopup="dialog"
              aria-label={`Посмотреть сводку о канале «${it.title || `@${it.handle}`}»`}
              onClick={() => setPreview(it)}
              className="group flex h-full w-full cursor-pointer flex-col rounded-sm border border-line bg-surface-2 p-3.5 text-start transition-[background-color,border-color,box-shadow] duration-150 hover:border-line-strong hover:bg-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
            >
              <div className="flex w-full items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3
                    className="truncate text-[14px] font-bold text-text"
                    title={it.title || `@${it.handle}`}
                  >
                    {it.title || `@${it.handle}`}
                  </h3>
                  <p className="mt-0.5 truncate text-[12px] font-semibold text-text-3">@{it.handle}</p>
                </div>
                {it.subscribers != null && (
                  <span className="nums shrink-0 text-[13px] text-text-3">{fmtCompact(it.subscribers)}</span>
                )}
              </div>

              <p
                className="mt-2 line-clamp-2 whitespace-pre-line break-words text-pretty text-[13px] leading-relaxed text-text-2"
                title={it.description || undefined}
              >
                {it.description || "Публичное описание Telegram пока недоступно."}
              </p>

              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {it.mentionedBy > 1 && <Badge tone="brand">×{it.mentionedBy} ссылки</Badge>}
                {it.onTopic === true ? (
                  <Badge tone="success">твоя тема</Badge>
                ) : (
                  <Badge tone="neutral">тему не проверил</Badge>
                )}
              </div>

              <span className="mt-auto flex w-full items-center justify-between gap-3 pt-3 text-[12px] font-semibold text-text-3 transition-colors group-hover:text-brand">
                <span>
                  {it.postsPerWeek == null ? `${fmtNum(it.posts)} постов в выборке` : postingRateLabel(it.postsPerWeek)}
                </span>
                <span className="inline-flex items-center gap-1.5 text-[13px] text-text-2 group-hover:text-brand">
                  Посмотреть сводку
                  <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>

      {preview && (
        <SuggestionPreviewDialog
          item={preview}
          atLimit={atLimit}
          fallbackFocusRef={searchButtonRef}
          onClose={() => setPreview(null)}
          onAdd={() => void act(preview, "add")}
          onDismiss={() => void act(preview, "dismiss")}
        />
      )}
    </Card>
  );
}

/* ----------------------------------------------------------------- ЭКРАН */

export default function CompetitorsPage() {
  const s = useStore();
  const reduced = useReducedMotion();

  const [list, setList] = useState<Competitor[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [picked, setPicked] = useState<number | null>(null);

  // Конкуренты живут НА КАНАЛЕ: у кофейного канала и юридического соседи разные.
  // Сервер это уже умеет (`?channel=`), но страница параметр не слала — и человек с тремя
  // каналами всегда видел соседей первого, без возможности переключиться.
  const { tgChannels, channelId } = useChannelChoice(s.realChannels, picked);

  const load = useCallback(async () => {
    if (!channelId) {
      setLoading(false);
      return;
    }
    try {
      const r = await fetch(`/api/competitors?channel=${channelId}`, { cache: "no-store" });
      const d = (await r.json()) as { competitors?: Competitor[] };
      setList(d.competitors ?? []);
    } catch {
      /* сеть — оставляем что было */
    } finally {
      setLoading(false);
    }
  }, [channelId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- загрузка списка при монтировании
    load();
  }, [load]);

  // Пока кто-то собирается — обновляем список, чтобы «Собираем…» сменилось на цифры.
  const hasPending = list.some((c) => c.status === "pending");
  useEffect(() => {
    if (!hasPending) return;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [hasPending, load]);

  const atLimit = list.length >= MAX;
  const autoAdded = list.filter((c) => c.auto_added);

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (submitting) return;
    const raw = value.trim();
    if (!raw) {
      setError(addErrorText("empty"));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/competitors/add", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // Без channelId сервер подставит первый канал — и конкурент кофейни молча уехал бы
        // в юридический.
        body: JSON.stringify({ url: raw, channelId }),
      });
      const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (res.ok && data?.ok) {
        setValue("");
        setOpen(false);
        s.toast({
          kind: "success",
          title: "Добавлен — собираю досье",
          body: "Открытая статистика его постов появится через пару минут.",
        });
        await load();
      } else {
        setError(addErrorText(data?.error));
      }
    } catch {
      setError("Сервер не ответил. Попробуй ещё раз.");
    } finally {
      setSubmitting(false);
    }
  };

  const remove = async (id: string) => {
    const name = list.find((c) => String(c.id) === id)?.title ?? "Конкурент";
    setConfirmId(null);
    setList((prev) => prev.filter((c) => String(c.id) !== id));
    try {
      await fetch(`/api/competitors/${id}`, { method: "DELETE" });
    } catch {
      /* всё равно перечитаем */
    }
    await load();
    s.toast({ kind: "info", title: `«${name}» удалён`, body: "Вернуть можно той же ссылкой." });
  };

  return (
    <AppShell
      title="Конкуренты"
      subtitle="Только открытые данные Telegram. Добавляй и удаляй свободно — досье собирается автоматически."
      action={
        <Button variant="brand" onClick={() => setOpen((v) => !v)} disabled={atLimit}>
          <Plus className="h-[18px] w-[18px]" strokeWidth={2.25} aria-hidden />
          Добавить
        </Button>
      }
    >
      {/* У каждого канала свои соседи: селектор говорит, про чью нишу сейчас речь */}
      <ChannelPicker
        channels={tgChannels}
        value={channelId}
        onChange={setPicked}
        label="Конкуренты канала"
        className="mb-6"
      />

      {/* Сводка автодобавленного. Метка на карточке — это хорошо, но её надо искать; сюда
          человек смотрит первым. Без явной отмены автоматика была бы сюрпризом. */}
      {autoAdded.length > 0 && (
        <div
          role="status"
          className="mb-5 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md bg-info-soft px-4 py-3"
        >
          <Sparkles className="h-4 w-4 shrink-0 text-info-text" strokeWidth={2.5} aria-hidden />
          <p className="text-[14px] leading-snug font-semibold text-info-text">
            Разведка сама нашла и добавила{" "}
            {autoAdded.length === 1
              ? `«${autoAdded[0].title || "@" + autoAdded[0].handle}»`
              : `${autoAdded.length} ${plural(autoAdded.length, "канал", "канала", "каналов")}`}{" "}
            по теме этого канала — чтобы лента идей не стояла пустой.
          </p>
          <span className="text-[13px] text-info-text/80">
            Не твои соседи? Убери крестиком на карточке.
          </span>
        </div>
      )}

      <Suggestions onAdded={load} atLimit={atLimit} channelId={channelId} />
      {/* Форма добавления */}
      <AnimatePresence initial={false}>
        {open && !atLimit && (
          <motion.div
            key="add-form"
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: -12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, y: -12 }}
            transition={{ duration: 0.24, ease: EASE }}
            className="mb-6"
          >
            <GlassCard className="p-5 sm:p-6">
              <form onSubmit={submit} noValidate className="space-y-4">
                <Field
                  label="Ссылка на Telegram-канал"
                  hint="Например: t.me/durov или @durov. Только публичные каналы."
                  htmlFor="competitor-link"
                  error={error ?? undefined}
                >
                  <Input
                    id="competitor-link"
                    value={value}
                    onChange={(e) => {
                      setValue(e.target.value);
                      if (error) setError(null);
                    }}
                    placeholder="t.me/durov"
                    inputMode="url"
                    autoComplete="off"
                    spellCheck={false}
                    aria-invalid={Boolean(error)}
                  />
                </Field>
                <div className="flex flex-wrap items-center gap-2">
                  <Button type="submit" variant="solid" loading={submitting}>
                    Добавить
                  </Button>
                  <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                    Отмена
                  </Button>
                  <p className="ml-auto hidden text-[13px] text-text-3 sm:block">
                    {list.length}/{MAX} — собираем только открытую статистику.
                  </p>
                </div>
              </form>
            </GlassCard>
          </motion.div>
        )}
      </AnimatePresence>

      {atLimit && (
        <div className="mb-6 flex items-start gap-2.5 rounded-md bg-surface-inset p-4 text-[14px] text-text-2">
          <Radar className="mt-0.5 h-4 w-4 shrink-0 text-text-3" aria-hidden />
          <p>
            У тебя максимум — <b className="font-semibold text-text">{MAX} конкурентов</b>. Это в 4 раза
            больше, чем у многих платных сервисов. Удали кого-то, чтобы добавить нового.
          </p>
        </div>
      )}

      {/* Сетка */}
      {loading ? (
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="skeleton h-44 rounded-lg" />
          ))}
        </div>
      ) : list.length === 0 ? (
        <Card className="py-4">
          <EmptyState
            icon={<Radar className="h-6 w-6" strokeWidth={1.75} aria-hidden />}
            title="Пока никого"
            body="Добавь конкурента по ссылке — платформа соберёт настоящую статистику его постов: сколько выходит, когда, с какой вовлечённостью."
            action={
              <Button variant="solid" onClick={() => setOpen(true)}>
                <Plus className="h-[18px] w-[18px]" strokeWidth={2.25} aria-hidden />
                Добавить конкурента
              </Button>
            }
          />
        </Card>
      ) : (
        <motion.ul layout="position" className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          <AnimatePresence initial={false}>
            {list.map((c) => (
              <motion.li
                key={c.id}
                layout="position"
                initial={{ opacity: 0, y: -8, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, scale: 0.96 }}
                transition={{ duration: 0.28, ease: EASE }}
              >
                <CompetitorCard
                  c={c}
                  confirming={confirmId === String(c.id)}
                  onAskDelete={() => setConfirmId(String(c.id))}
                  onCancelDelete={() => setConfirmId(null)}
                  onDelete={() => remove(String(c.id))}
                />
              </motion.li>
            ))}
          </AnimatePresence>
        </motion.ul>
      )}

      {/* Честность источника */}
      {list.length > 0 && (
        <div className={cn("mt-6 flex items-start gap-2.5 text-[13px] leading-relaxed text-text-3")}>
          <span aria-hidden>🔒</span>
          <p>
            Собираем только открытые данные: тексты постов, просмотры, время выхода, тип вложения,
            подписчиков. Реакций, пересылок и комментариев публичная лента Telegram не отдаёт —
            поэтому их тут нет. Закрытого — демографии аудитории, расходов на рекламу — не собираем.
          </p>
        </div>
      )}
    </AppShell>
  );
}
