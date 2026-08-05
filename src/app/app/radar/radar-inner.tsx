"use client";

// Нишевой радар: полнотекстовый поиск по постам конкурентов/трендов + алерты по ключевым словам.

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { motion } from "motion/react";
import { Bell, Eye, Heart, Link2, Plus, Radar, RefreshCw, Search, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge, Card, EmptyState, Input } from "@/components/ui/primitives";
import { useStore } from "@/lib/store";
import { cn, fmtAgo, fmtNum } from "@/lib/utils";

/* ------------------------------------------------------------------ ТИПЫ */

type SearchResult = {
  id: number;
  text: string | null;
  views: number | null;
  reactions: number | null;
  posted_at: string | null;
  source_title: string | null;
  source_handle: string | null;
  origin: "competitor" | "trend";
};

type Alert = {
  id: number;
  channel_id: number;
  channel_title: string | null;
  keyword: string;
  is_active: boolean;
  last_notified_at: string | null;
  matches_count: number;
  created_at: string;
};

type Channel = { id: number; title: string };

/* ----------------------------------------------------------------- ЭКРАН */

export function RadarInner({
  onStats,
}: {
  onStats?: (s: { alerts: Alert[] }) => void;
}) {
  const s = useStore();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [loadError, setLoadError] = useState(false);

  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [newKeyword, setNewKeyword] = useState("");
  const [alertChannelId, setAlertChannelId] = useState<number | null>(null);
  const [savingAlert, setSavingAlert] = useState(false);

  const loadAlerts = useCallback(async () => {
    try {
      const r = await fetch("/api/radar/alerts", { cache: "no-store" });
      if (r.ok) {
        const d = await r.json();
        const as: Alert[] = d.alerts ?? [];
        setAlerts(as);
        onStats?.({ alerts: as });
        setLoadError(false);
      } else {
        setLoadError(true);
      }
    } catch { setLoadError(true); }
  }, [onStats]);

  const loadChannels = useCallback(async () => {
    try {
      const r = await fetch("/api/channels", { cache: "no-store" });
      if (r.ok) {
        const d = await r.json();
        const chs: Channel[] = (d.channels ?? []).map((c: { id: number; title: string }) => ({ id: c.id, title: c.title }));
        setChannels(chs);
        if (chs.length) setAlertChannelId(chs[0].id);
        setLoadError(false);
      } else {
        setLoadError(true);
      }
    } catch { setLoadError(true); }
  }, []);

  const reload = useCallback(() => {
    setLoadError(false);
    setLoaded(false);
    Promise.all([loadAlerts(), loadChannels()]).finally(() => setLoaded(true));
  }, [loadAlerts, loadChannels]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    reload();
  }, [reload]);

  const doSearch = async () => {
    const query = q.trim();
    if (!query) return;
    setSearching(true);
    setSearched(true);
    try {
      const r = await fetch(`/api/radar/search?q=${encodeURIComponent(query)}`, { cache: "no-store" });
      if (r.ok) {
        const d = await r.json();
        setResults(d.results ?? []);
      } else {
        s.toast({ kind: "danger", title: "Ошибка поиска" });
      }
    } catch {
      s.toast({ kind: "danger", title: "Сетевая ошибка" });
    }
    setSearching(false);
  };

  const addAlert = async () => {
    const keyword = newKeyword.trim();
    if (!keyword || !alertChannelId) return;
    setSavingAlert(true);
    try {
      const r = await fetch("/api/radar/alerts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ keyword, channelId: alertChannelId }),
      });
      if (r.ok) {
        setNewKeyword("");
        await loadAlerts();
        s.toast({ kind: "success", title: `Алерт «${keyword}» создан` });
      } else {
        s.toast({ kind: "danger", title: "Не удалось создать алерт" });
      }
    } catch {
      s.toast({ kind: "danger", title: "Сетевая ошибка" });
    }
    setSavingAlert(false);
  };

  const deleteAlert = async (id: number) => {
    await fetch(`/api/radar/alerts?id=${id}`, { method: "DELETE" });
    const next = alerts.filter((a) => a.id !== id);
    setAlerts(next);
    onStats?.({ alerts: next });
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

      {/* Guard: без конкурентов радар пуст — поиск ищет по их постам */}
      {loaded && !loadError && channels.length === 0 ? (
        <Card className="mt-5">
          <EmptyState
            icon={<Radar className="h-6 w-6" />}
            title="Сначала добавь конкурентов"
            body="Радар ищет по постам каналов-конкурентов. Добавь хотя бы один — и поиск заработает."
            action={
              <Link href="/app/competitors">
                <Button variant="solid" size="sm">
                  <Link2 className="h-4 w-4" />
                  Добавить конкурентов
                </Button>
              </Link>
            }
          />
        </Card>
      ) : (
        <>
      {/* Поиск */}
      <Card className="mt-5 p-4">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-3" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && doSearch()}
              placeholder="Поиск по постам конкурентов и трендов…"
              className="pl-9"
            />
          </div>
          <Button variant="solid" size="sm" onClick={doSearch} loading={searching} disabled={!q.trim()}>
            Найти
          </Button>
        </div>
      </Card>

      {/* Результаты поиска */}
      {searched && (
        <div className="mt-4 grid gap-3 lg:grid-cols-2">
          {searching ? (
            [0, 1, 2].map((i) => <div key={i} className="skeleton h-24" />)
          ) : results.length === 0 ? (
            <div className="lg:col-span-2">
              <EmptyState
                icon={<Search className="h-5 w-5" />}
                title="Ничего не найдено"
                body="Попробуй другой запрос — поиск полнотекстовый, по русскому языку."
              />
            </div>
          ) : (
            results.map((r, i) => (
              <motion.div
                key={`${r.origin}-${r.id}`}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ type: "spring", bounce: 0.15, duration: 0.4, delay: Math.min(i, 6) * 0.06 }}
              >
                <Card className="p-4 transition-all duration-200 hover:border-line-strong hover:shadow-soft">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-text-3">
                    <Badge tone={r.origin === "competitor" ? "brand" : "fire"}>
                      {r.origin === "competitor" ? "Конкурент" : "Тренд"}
                    </Badge>
                    <span className="font-semibold text-text-2">
                      {r.source_title || (r.source_handle ? `@${r.source_handle}` : "—")}
                    </span>
                    {r.posted_at && <span>{fmtAgo(r.posted_at)}</span>}
                  </div>
                  <p className="mt-1.5 line-clamp-4 text-[14px] leading-relaxed whitespace-pre-wrap text-text">
                    {r.text || "(без текста)"}
                  </p>
                  {(r.views != null || r.reactions != null) && (
                    <div className="mt-2 flex items-center gap-3 text-[12px] text-text-3">
                      {r.views != null && (
                        <span className="inline-flex items-center gap-1">
                          <Eye className="h-3.5 w-3.5" aria-hidden />
                          {fmtNum(r.views)}
                        </span>
                      )}
                      {r.reactions != null && (
                        <span className="inline-flex items-center gap-1">
                          <Heart className="h-3.5 w-3.5" aria-hidden />
                          {fmtNum(r.reactions)}
                        </span>
                      )}
                    </div>
                  )}
                </Card>
              </motion.div>
            ))
          )}
        </div>
      )}

      {/* Алерты */}
      <div className="mt-8">
        <h2 className="flex items-center gap-2 text-[15px] font-bold text-text">
          <Bell className="h-4 w-4" />
          Алерты по ключевым словам
        </h2>
        <p className="mt-1 text-[13px] text-text-3">
          Воркер проверяет новые посты конкурентов каждые 2 часа и пушит совпадения в бота.
        </p>

        <Card className="mt-3 p-4">
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              value={newKeyword}
              onChange={(e) => setNewKeyword(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addAlert()}
              placeholder="Ключевое слово или фраза"
              className="flex-1"
            />
            <select
              value={alertChannelId ?? ""}
              onChange={(e) => setAlertChannelId(Number(e.target.value) || null)}
              className="rounded-sm border border-line bg-surface-inset px-3 py-2 text-[13px] text-text focus:border-brand focus:outline-none"
            >
              {channels.map((c) => (
                <option key={c.id} value={c.id}>{c.title}</option>
              ))}
            </select>
            <Button variant="solid" size="sm" onClick={addAlert} loading={savingAlert} disabled={!newKeyword.trim()}>
              <Plus className="h-4 w-4" />
              Создать
            </Button>
          </div>
        </Card>

        <div className="mt-3 flex flex-wrap gap-2">
          {alerts.map((a) => (
            <span
              key={a.id}
              className={cn(
                "inline-flex items-center gap-2 rounded-full border border-line bg-surface py-1 pl-3 pr-1.5 text-[13px]",
                !a.is_active && "opacity-55",
              )}
            >
              <span className="font-semibold text-text">{a.keyword}</span>
              <span className="text-[11px] text-text-3">{a.channel_title ?? "—"}</span>
              {a.matches_count > 0 && (
                <span className="rounded-full bg-surface-inset px-1.5 py-0.5 text-[11px] font-semibold text-text-2">
                  {a.matches_count}
                </span>
              )}
              <button
                type="button"
                onClick={() => deleteAlert(a.id)}
                aria-label={`Удалить алерт «${a.keyword}»`}
                className="flex h-5 w-5 items-center justify-center rounded-full text-text-3 transition-colors duration-200 hover:bg-danger-soft hover:text-danger-text"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      </div>
        </>
      )}
    </div>
  );
}
