"use client";

// Нишевой радар: полнотекстовый поиск по постам конкурентов/трендов + алерты по ключевым словам.

import { useCallback, useEffect, useState } from "react";
import { Bell, Plus, Search, Trash2 } from "lucide-react";

import { AppShell } from "@/components/app/shell";
import { Button } from "@/components/ui/button";
import { Badge, Card, EmptyState, Input } from "@/components/ui/primitives";
import { useStore } from "@/lib/store";
import { fmtNum } from "@/lib/utils";

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

function RadarInner() {
  const s = useStore();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);

  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [newKeyword, setNewKeyword] = useState("");
  const [alertChannelId, setAlertChannelId] = useState<number | null>(null);
  const [savingAlert, setSavingAlert] = useState(false);

  const loadAlerts = useCallback(async () => {
    try {
      const r = await fetch("/api/radar/alerts", { cache: "no-store" });
      if (r.ok) {
        const d = await r.json();
        setAlerts(d.alerts ?? []);
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
        if (chs.length) setAlertChannelId(chs[0].id);
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadAlerts();
    loadChannels();
  }, [loadAlerts, loadChannels]);

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
      }
    } catch { /* ignore */ }
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
      }
    } catch { /* ignore */ }
    setSavingAlert(false);
  };

  const deleteAlert = async (id: number) => {
    await fetch(`/api/radar/alerts?id=${id}`, { method: "DELETE" });
    setAlerts((prev) => prev.filter((a) => a.id !== id));
  };

  const fmtDate = (iso: string | null) => {
    if (!iso) return "";
    return new Date(iso).toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
  };

  return (
    <div className="mx-auto w-full max-w-3xl">
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
        <div className="mt-4 space-y-3">
          {searching ? (
            [0, 1, 2].map((i) => <div key={i} className="skeleton h-24" />)
          ) : results.length === 0 ? (
            <EmptyState
              icon={<Search className="h-5 w-5" />}
              title="Ничего не найдено"
              body="Попробуй другой запрос — поиск полнотекстовый, по русскому языку."
            />
          ) : (
            results.map((r) => (
              <Card key={`${r.origin}-${r.id}`} className="p-4">
                <div className="flex items-center gap-2 text-[12px] text-text-3">
                  <Badge tone={r.origin === "competitor" ? "brand" : "fire"}>
                    {r.origin === "competitor" ? "Конкурент" : "Тренд"}
                  </Badge>
                  <span className="font-medium text-text-2">
                    {r.source_title || (r.source_handle ? `@${r.source_handle}` : "—")}
                  </span>
                  {r.posted_at && <span>· {fmtDate(r.posted_at)}</span>}
                </div>
                <p className="mt-2 line-clamp-4 text-[14px] leading-relaxed whitespace-pre-wrap text-text">
                  {r.text || "(без текста)"}
                </p>
                {(r.views != null || r.reactions != null) && (
                  <div className="mt-2 flex gap-3 text-[12px] text-text-3">
                    {r.views != null && <span>👁 {fmtNum(r.views)}</span>}
                    {r.reactions != null && <span>❤️ {fmtNum(r.reactions)}</span>}
                  </div>
                )}
              </Card>
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

        <div className="mt-3 space-y-2">
          {alerts.map((a) => (
            <Card key={a.id} className="flex items-center gap-3 p-3">
              <div className="min-w-0 flex-1">
                <p className="text-[14px] font-semibold text-text">{a.keyword}</p>
                <p className="text-[12px] text-text-3">
                  {a.channel_title ?? "—"} · совпадений: {a.matches_count}
                  {a.last_notified_at && ` · посл. ${fmtDate(a.last_notified_at)}`}
                </p>
              </div>
              <Badge tone={a.is_active ? "success" : "neutral"}>
                {a.is_active ? "Активен" : "Выкл"}
              </Badge>
              <Button variant="ghost" size="sm" onClick={() => deleteAlert(a.id)} className="text-danger-text">
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function RadarPage() {
  return (
    <AppShell title="Радар" subtitle="Полнотекстовый поиск по нише и алерты по ключевым словам.">
      <RadarInner />
    </AppShell>
  );
}
