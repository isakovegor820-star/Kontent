"use client";

// RSS-ленты: добавление фидов, статус, пауза/возобновление, удаление.

import { useCallback, useEffect, useState } from "react";
import { Pause, Play, Plus, Rss, Trash2 } from "lucide-react";

import { AppShell } from "@/components/app/shell";
import { Button } from "@/components/ui/button";
import { Badge, Card, EmptyState, Input } from "@/components/ui/primitives";
import { useStore } from "@/lib/store";

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

/* ----------------------------------------------------------------- ЭКРАН */

function RssInner() {
  const s = useStore();
  const [feeds, setFeeds] = useState<Feed[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);

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
      }
    } catch { /* ignore */ }
  }, []);

  const loadChannels = useCallback(async () => {
    try {
      const r = await fetch("/api/channels", { cache: "no-store" });
      if (r.ok) {
        const d = await r.json();
        const chs: Channel[] = (d.channels ?? []).map((c: { id: number; title: string }) => ({ id: c.id, title: c.title }));
        setChannels(chs);
        if (chs.length && !channelId) setChannelId(chs[0].id);
      }
    } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    Promise.all([load(), loadChannels()]).finally(() => setLoading(false));
  }, [load, loadChannels]);

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

  const fmtDate = (iso: string | null) => {
    if (!iso) return "ещё не загружалась";
    const d = new Date(iso);
    return d.toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  };

  return (
    <div className="mx-auto w-full max-w-3xl">
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
      </Card>

      {/* Список фидов */}
      <div className="mt-5 space-y-3">
        {loading ? (
          [0, 1].map((i) => <div key={i} className="skeleton h-24" />)
        ) : feeds.length === 0 ? (
          <EmptyState
            icon={<Rss className="h-5 w-5" />}
            title="Лент пока нет"
            body="Добавь RSS или Atom-ленту — воркер будет парсить новые записи и создавать посты."
          />
        ) : (
          feeds.map((f) => (
            <Card key={f.id} className="p-4">
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
                    <span>· {fmtDate(f.last_fetched_at)}</span>
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
