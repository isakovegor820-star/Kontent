"use client";

// RSS-ленты: добавление фидов, статус, пауза/возобновление, удаление + ЖУРНАЛ записей.
// Журнал отвечает на вопрос «работает ли оно вообще?»: видно каждую запись из ленты
// и её судьбу — пост создан (ссылка в календарь), пропущена по лимиту или в работе.

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ExternalLink,
  Link2,
  Newspaper,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Rss,
  Trash2,
} from "lucide-react";

import { AppShell } from "@/components/app/shell";
import { Button } from "@/components/ui/button";
import { Badge, Card, EmptyState, Input } from "@/components/ui/primitives";
import { useStore } from "@/lib/store";
import { cn, fmtAgo } from "@/lib/utils";

/* ------------------------------------------------------------------ ТИПЫ */

type Feed = {
  id: number;
  url: string;
  title: string | null;
  channel_id: number;
  channel_title: string | null;
  is_active: boolean;
  ai_summarize: boolean;
  max_per_day: number;
  last_fetched_at: string | null;
  created_at: string;
};

type Channel = { id: number; title: string };

type RssItem = {
  id: number;
  title: string | null;
  link: string | null;
  published_at: string | null;
  status: "new" | "posted" | "skipped";
  post_id: number | null;
  fetched_at: string;
  feed_title: string | null;
};

// Карточки поднимаются при наведении — единый жест рабочих экранов.
const HOVER =
  "transition-[box-shadow,border-color] duration-200 hover:border-line-strong hover:shadow-soft";

/* ----------------------------------------------------------------- ЭКРАН */

function RssInner() {
  const s = useStore();
  const [feeds, setFeeds] = useState<Feed[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [items, setItems] = useState<RssItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Форма добавления
  const [url, setUrl] = useState("");
  const [channelId, setChannelId] = useState<number | null>(null);
  const [aiSummarize, setAiSummarize] = useState(true);
  const [maxPerDay, setMaxPerDay] = useState(3);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/rss", { cache: "no-store" });
      if (r.ok) {
        const d = await r.json();
        setFeeds(d.feeds ?? []);
        setLoadError(false);
      } else {
        setLoadError(true);
      }
    } catch { setLoadError(true); }
  }, []);

  const loadItems = useCallback(async () => {
    try {
      const r = await fetch("/api/rss/items", { cache: "no-store" });
      if (r.ok) {
        const d = await r.json();
        setItems(d.items ?? []);
      }
    } catch { /* журнал не критичен — молча оставляем старое */ }
  }, []);

  const loadChannels = useCallback(async () => {
    try {
      const r = await fetch("/api/channels", { cache: "no-store" });
      if (r.ok) {
        const d = await r.json();
        const chs: Channel[] = (d.channels ?? []).map((c: { id: number; title: string }) => ({ id: c.id, title: c.title }));
        setChannels(chs);
        if (chs.length && !channelId) setChannelId(chs[0].id);
        setLoadError(false);
      } else {
        setLoadError(true);
      }
    } catch { setLoadError(true); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const reload = useCallback(() => {
    setLoadError(false);
    setLoading(true);
    Promise.all([load(), loadChannels(), loadItems()]).finally(() => setLoading(false));
  }, [load, loadChannels, loadItems]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    reload();
  }, [reload]);

  // Таймер отложенного обновления журнала чистим при размонтировании.
  useEffect(() => {
    return () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, []);

  const addFeed = async () => {
    const trimmed = url.trim();
    if (!trimmed || !channelId) return;
    setSaving(true);
    try {
      const r = await fetch("/api/rss", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: trimmed, channelId, aiSummarize, maxPerDay }),
      });
      const d = await r.json();
      if (r.ok && d.ok) {
        setUrl("");
        await load();
        s.toast({ kind: "success", title: d.title ? `Лента «${d.title}» добавлена` : "Лента добавлена" });
      } else {
        const msg = d.error === "fetch_failed" ? "Не удалось загрузить ленту. Проверь URL." : d.error === "bad_url" ? "Некорректный URL" : "Ошибка";
        s.toast({ kind: "danger", title: msg });
      }
    } catch {
      s.toast({ kind: "danger", title: "Сетевая ошибка" });
    }
    setSaving(false);
  };

  const toggleActive = async (feed: Feed) => {
    await fetch(`/api/rss/${feed.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ isActive: !feed.is_active }),
    });
    setFeeds((prev) => prev.map((f) => (f.id === feed.id ? { ...f, is_active: !f.is_active } : f)));
  };

  const removeFeed = async (id: number) => {
    await fetch(`/api/rss/${id}`, { method: "DELETE" });
    setFeeds((prev) => prev.filter((f) => f.id !== id));
    s.toast({ kind: "info", title: "Лента удалена" });
  };

  // «Проверить сейчас»: воркер собирает ленты вне очереди крона. Сбор занимает
  // секунды — журнал перечитываем с задержкой, а не сразу.
  const refreshNow = async () => {
    setRefreshing(true);
    try {
      const r = await fetch("/api/rss/refresh", { method: "POST" });
      if (r.ok) {
        s.toast({ kind: "info", title: "Проверяю ленты — записи появятся через минуту" });
        refreshTimer.current = setTimeout(() => loadItems(), 20_000);
      } else {
        s.toast({ kind: "danger", title: "Не удалось запустить проверку" });
      }
    } catch {
      s.toast({ kind: "danger", title: "Сетевая ошибка" });
    }
    setRefreshing(false);
  };

  const statusBadge = (it: RssItem) => {
    if (it.status === "posted") return <Badge tone="success">Пост создан</Badge>;
    if (it.status === "skipped") return <Badge tone="neutral">Пропущено: лимит</Badge>;
    return <Badge tone="brand">В работе</Badge>;
  };

  return (
    <div className="mx-auto w-full">
      {/* Ошибка загрузки */}
      {loadError && (
        <Card className="mt-5 p-4">
          <div className="flex items-center justify-between">
            <p className="text-[14px] text-text">Не удалось загрузить данные</p>
            <Button variant="soft" size="sm" onClick={reload}>
              <RefreshCw className="h-4 w-4" />
              Повторить
            </Button>
          </div>
        </Card>
      )}

      {/* Guard: без канала RSS бесполезен — посты некуда публиковать */}
      {!loading && channels.length === 0 ? (
        <Card className="mt-5">
          <EmptyState
            icon={<Link2 className="h-6 w-6" />}
            title="Сначала подключи канал"
            body="RSS-репостер публикует посты в твой канал. Подключи Telegram или VK — и возвращайся сюда."
            action={
              <Link href="/app/settings">
                <Button variant="solid" size="sm">
                  <Link2 className="h-4 w-4" />
                  Подключить канал
                </Button>
              </Link>
            }
          />
        </Card>
      ) : (
        <>
      {/* Форма добавления */}
      <Card className="mt-5 p-4">
        <p className="mb-3 text-[13px] font-semibold text-text-2">Добавить RSS/Atom-ленту</p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com/feed.xml"
            className="flex-1"
          />
          <select
            value={channelId ?? ""}
            onChange={(e) => setChannelId(Number(e.target.value) || null)}
            className="rounded-sm border border-line bg-surface-inset px-3 py-2 text-[13px] text-text focus:border-brand focus:outline-none"
          >
            {channels.map((c) => (
              <option key={c.id} value={c.id}>{c.title}</option>
            ))}
          </select>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-1.5 text-[13px] text-text-2">
            <input
              type="checkbox"
              checked={aiSummarize}
              onChange={(e) => setAiSummarize(e.target.checked)}
              className="accent-brand h-3.5 w-3.5"
            />
            ИИ-суммаризация
          </label>
          <label className="flex items-center gap-1.5 text-[13px] text-text-2">
            Макс/день:
            <input
              type="number"
              min={1}
              max={20}
              value={maxPerDay}
              onChange={(e) => setMaxPerDay(Number(e.target.value) || 3)}
              className="w-14 rounded-sm border border-line bg-surface-inset px-2 py-1 text-[13px] text-text focus:border-brand focus:outline-none"
            />
          </label>
          <Button variant="solid" size="sm" onClick={addFeed} loading={saving} disabled={!url.trim() || !channelId} className="ml-auto">
            <Plus className="h-4 w-4" />
            Добавить
          </Button>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-line pt-3">
          <p className="text-[12px] text-text-3">
            Посты появятся автоматически — проверка каждые 30 минут.
          </p>
          <Button variant="soft" size="sm" onClick={refreshNow} loading={refreshing} className="ml-auto">
            <RefreshCw className="h-3.5 w-3.5" />
            Проверить сейчас
          </Button>
        </div>
      </Card>

      {/* Список фидов */}
      <div className="mt-5 grid gap-3 lg:grid-cols-2">
        {loading ? (
          [0, 1].map((i) => <div key={i} className="skeleton h-24" />)
        ) : feeds.length === 0 ? (
          <Card className="lg:col-span-2">
            <EmptyState
              icon={<Rss className="h-5 w-5" />}
              title="Лент пока нет"
              body="Добавь RSS или Atom-ленту — воркер будет парсить новые записи и создавать посты."
            />
          </Card>
        ) : (
          feeds.map((f) => (
            <Card key={f.id} className={cn("p-4", HOVER)}>
              <div className="flex items-start gap-3">
                <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-sm bg-info-soft">
                  <Rss className="h-4 w-4 text-info-text" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[14px] font-semibold text-text">
                    {f.title || f.url}
                  </p>
                  <p className="mt-0.5 truncate text-[12px] text-text-3">{f.url}</p>
                  <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[12px] text-text-3">
                    <Badge tone={f.is_active ? "success" : "neutral"}>
                      {f.is_active ? "Активна" : "Пауза"}
                    </Badge>
                    {f.channel_title && <Badge tone="neutral">→ {f.channel_title}</Badge>}
                    {f.ai_summarize && <Badge tone="brand">ИИ</Badge>}
                    <span>макс {f.max_per_day}/день</span>
                    <span>· {f.last_fetched_at ? fmtAgo(f.last_fetched_at) : "ещё не загружалась"}</span>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <Button variant="ghost" size="sm" onClick={() => toggleActive(f)} title={f.is_active ? "Пауза" : "Возобновить"}>
                    {f.is_active ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => removeFeed(f.id)} className="text-danger-text" title="Удалить">
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            </Card>
          ))
        )}
      </div>

      {/* Журнал записей: что пришло из лент и что с этим стало */}
      <div className="mt-8 flex items-center gap-2.5">
        <div className="flex h-8 w-8 items-center justify-center rounded-sm bg-info-soft">
          <Newspaper className="h-4 w-4 text-info-text" />
        </div>
        <div>
          <h2 className="text-[15px] font-bold text-text">Журнал</h2>
          <p className="text-[13px] text-text-3">Что пришло из лент и что с этим стало.</p>
        </div>
      </div>

      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        {loading ? (
          [0, 1].map((i) => <div key={i} className="skeleton h-20" />)
        ) : items.length === 0 ? (
          <Card className="lg:col-span-2">
            <EmptyState
              icon={<Newspaper className="h-5 w-5" />}
              title="Пока ничего не приходило"
              body="Как только в лентах появятся новые записи, они будут здесь — со статусом и ссылкой на созданный пост."
            />
          </Card>
        ) : (
          items.map((it) => (
            <Card key={it.id} className={cn("flex flex-col p-4", HOVER)}>
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  {it.link ? (
                    <a
                      href={it.link}
                      target="_blank"
                      rel="noreferrer"
                      className="line-clamp-2 text-[14px] font-semibold text-text underline-offset-4 hover:underline"
                    >
                      {it.title || it.link}
                    </a>
                  ) : (
                    <p className="line-clamp-2 text-[14px] font-semibold text-text">
                      {it.title || "Без заголовка"}
                    </p>
                  )}
                  <p className="mt-1 text-[12px] text-text-3">
                    {it.feed_title && <span className="font-semibold text-text-2">{it.feed_title} · </span>}
                    {fmtAgo(it.published_at ?? it.fetched_at)}
                  </p>
                </div>
                {it.link && (
                  <a
                    href={it.link}
                    target="_blank"
                    rel="noreferrer"
                    title="Открыть запись"
                    className="shrink-0 rounded-xs p-1 text-text-3 transition-colors hover:bg-surface-inset hover:text-text"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                )}
              </div>
              <div className="mt-3 flex items-center gap-2 border-t border-line pt-3">
                {statusBadge(it)}
                {it.status === "posted" && it.post_id && (
                  <Link
                    href="/app/calendar"
                    className="rounded-xs text-[12px] font-semibold text-text-3 underline-offset-4 transition-colors hover:text-text hover:underline"
                  >
                    В календарь →
                  </Link>
                )}
              </div>
            </Card>
          ))
        )}
      </div>
        </>
      )}
    </div>
  );
}

export default function RssPage() {
  return (
    <AppShell title="RSS-ленты" subtitle="Автоматический репост из RSS/Atom-лент с ИИ-суммаризацией.">
      <RssInner />
    </AppShell>
  );
}
