"use client";

// Мониторинг упоминаний: лента упоминаний + управление ключевыми словами.

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AtSign, ExternalLink, Link2, Plus, RefreshCw, Trash2 } from "lucide-react";

import { AppShell } from "@/components/app/shell";
import { Button } from "@/components/ui/button";
import { Badge, Card, EmptyState, Input } from "@/components/ui/primitives";
import { useStore } from "@/lib/store";

/* ------------------------------------------------------------------ ТИПЫ */

type Mention = {
  id: number;
  query_id: number;
  network: "tg" | "vk";
  source_handle: string | null;
  source_title: string | null;
  post_url: string | null;
  text: string | null;
  author: string | null;
  posted_at: string | null;
  found_at: string;
  keyword: string;
};

type MentionQuery = {
  id: number;
  keyword: string;
  networks: string[];
  is_active: boolean;
  last_checked_at: string | null;
  channel_title: string | null;
  created_at: string;
};

type Channel = { id: number; title: string };

/* ----------------------------------------------------------------- ЭКРАН */

function MentionsInner() {
  const s = useStore();
  const [mentions, setMentions] = useState<Mention[]>([]);
  const [queries, setQueries] = useState<MentionQuery[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  // Форма
  const [keyword, setKeyword] = useState("");
  const [channelId, setChannelId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/mentions", { cache: "no-store" });
      if (r.ok) {
        const d = await r.json();
        setMentions(d.mentions ?? []);
        setQueries(d.queries ?? []);
        setLoadError(false);
      } else {
        setLoadError(true);
      }
    } catch { setLoadError(true); }
  }, []);

  const loadChannels = useCallback(async () => {
    try {
      const r = await fetch("/api/channels", { cache: "no-store" });
      if (r.ok) {
        const d = await r.json();
        const chs: Channel[] = (d.channels ?? []).map((c: { id: number; title: string }) => ({ id: c.id, title: c.title }));
        setChannels(chs);
        if (chs.length) setChannelId(chs[0].id);
        setLoadError(false);
      } else {
        setLoadError(true);
      }
    } catch { setLoadError(true); }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    Promise.all([load(), loadChannels()]).finally(() => setLoading(false));
  }, [load, loadChannels]);

  const addQuery = async () => {
    const kw = keyword.trim();
    if (!kw || kw.length < 3 || !channelId) return;
    setSaving(true);
    try {
      const r = await fetch("/api/mentions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ keyword: kw, channelId }),
      });
      if (r.ok) {
        setKeyword("");
        await load();
        s.toast({ kind: "success", title: `Мониторинг «${kw}» запущен` });
      } else {
        s.toast({ kind: "danger", title: "Не удалось добавить запрос" });
      }
    } catch {
      s.toast({ kind: "danger", title: "Сетевая ошибка" });
    }
    setSaving(false);
  };

  const deleteQuery = async (id: number) => {
    await fetch(`/api/mentions/${id}`, { method: "DELETE" });
    setQueries((prev) => prev.filter((q) => q.id !== id));
    s.toast({ kind: "info", title: "Запрос удалён" });
  };

  const fmtDate = (iso: string | null) => {
    if (!iso) return "";
    return new Date(iso).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  };

  return (
    <div className="mx-auto w-full max-w-3xl">
      {/* Ошибка загрузки */}
      {loadError && (
        <Card className="mt-5 p-4">
          <div className="flex items-center justify-between">
            <p className="text-[14px] text-text">Не удалось загрузить данные</p>
            <Button variant="soft" size="sm" onClick={() => { setLoadError(false); setLoading(true); Promise.all([load(), loadChannels()]).finally(() => setLoading(false)); }}>
              <RefreshCw className="h-4 w-4" />
              Повторить
            </Button>
          </div>
        </Card>
      )}

      {/* Guard: без канала мониторинг бесполезен — не к чему привязать запросы */}
      {!loading && channels.length === 0 ? (
        <Card className="mt-5">
          <EmptyState
            icon={<Link2 className="h-6 w-6" />}
            title="Сначала подключи канал"
            body="Мониторинг упоминаний привязан к твоему каналу. Подключи Telegram или VK — и возвращайся сюда."
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
        <p className="mb-1 text-[13px] font-semibold text-text-2">Что отслеживать?</p>
        <p className="mb-3 text-[12px] text-text-3">
          Добавь то, что хочешь держать на контроле: название бренда, своё имя, продукт или конкурента.
        </p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addQuery()}
            placeholder="Например: «Аврора», «Иван Петров», «доставка цветов»"
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
          <Button variant="solid" size="sm" onClick={addQuery} loading={saving} disabled={!keyword.trim() || keyword.trim().length < 3}>
            <Plus className="h-4 w-4" />
            Отслеживать
          </Button>
        </div>
        <p className="mt-2 text-[12px] text-text-3">
          Ищем каждый час в Telegram и VK. Как только найдём упоминание — пришлём его тебе в бота со ссылкой на пост.
        </p>
      </Card>

      {/* Первый визит: объясняем ценность и механику простыми словами */}
      {queries.length === 0 && !loading && (
        <Card className="mt-4 p-4">
          <p className="text-[13px] font-semibold text-text-2">Как это работает</p>
          <ol className="mt-3 space-y-3">
            <li className="flex gap-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-info-soft text-[12px] font-bold text-info-text">1</span>
              <p className="text-[13px] leading-relaxed text-text">
                <span className="font-semibold">Добавь ключевые слова</span> — то, что важно не пропустить: бренд, имя, продукт, тему.
              </p>
            </li>
            <li className="flex gap-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-info-soft text-[12px] font-bold text-info-text">2</span>
              <p className="text-[13px] leading-relaxed text-text">
                <span className="font-semibold">Аврора ищет каждый час</span> — сканирует посты в Telegram и по всему VK на эти слова.
              </p>
            </li>
            <li className="flex gap-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-info-soft text-[12px] font-bold text-info-text">3</span>
              <p className="text-[13px] leading-relaxed text-text">
                <span className="font-semibold">Получай упоминания</span> — кто-то написал о тебе? Придёт уведомление в бота и появится здесь. Отвечай, пока горячо.
              </p>
            </li>
          </ol>
          <p className="mt-3 border-t border-line pt-3 text-[12px] leading-relaxed text-text-3">
            Зачем: следить за репутацией, находить клиентов, которые обсуждают твою тему, и вовремя реагировать на конкурентов.
          </p>
        </Card>
      )}

      {/* Активные запросы */}
      {queries.length > 0 && (
        <div className="mt-4">
          <p className="mb-2 text-[13px] font-semibold text-text-2">Активные запросы</p>
          <div className="flex flex-wrap gap-2">
            {queries.map((q) => (
              <span
                key={q.id}
                className="inline-flex items-center gap-1.5 rounded-sm border border-line bg-surface px-2.5 py-1 text-[13px] text-text"
              >
                <Badge tone={q.is_active ? "success" : "neutral"}>{q.keyword}</Badge>
                <span className="text-[11px] text-text-3">{(q.networks || []).join(", ")}</span>
                <button
                  type="button"
                  onClick={() => deleteQuery(q.id)}
                  className="ml-1 text-text-3 hover:text-danger-text"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Лента упоминаний */}
      <div className="mt-6">
        <h2 className="text-[15px] font-bold text-text">Лента упоминаний</h2>
        <div className="mt-3 space-y-3">
          {loading ? (
            [0, 1, 2].map((i) => <div key={i} className="skeleton h-24" />)
          ) : mentions.length === 0 ? (
            <EmptyState
              icon={<AtSign className="h-5 w-5" />}
              title="Пока тихо"
              body={queries.length === 0
                ? "Добавь ключевое слово выше — и мы начнём искать упоминания в Telegram и VK каждый час."
                : "Ищем по твоим запросам. Как только кто-то упомянет ключевое слово — упоминание появится здесь и придёт в бота."}
            />
          ) : (
            mentions.map((m) => (
              <Card key={m.id} className="p-4">
                <div className="flex items-center gap-2 text-[12px] text-text-3">
                  <Badge tone={m.network === "tg" ? "brand" : "fire"}>
                    {m.network === "tg" ? "Telegram" : "VK"}
                  </Badge>
                  <span className="font-medium text-text-2">
                    {m.source_title || m.source_handle || "—"}
                  </span>
                  <span>· «{m.keyword}»</span>
                  <span>· {fmtDate(m.found_at)}</span>
                </div>
                <p className="mt-2 line-clamp-4 text-[14px] leading-relaxed whitespace-pre-wrap text-text">
                  {m.text || "(без текста)"}
                </p>
                {m.post_url && (
                  <a
                    href={m.post_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-2 inline-flex items-center gap-1 text-[12px] text-info-text hover:underline"
                  >
                    <ExternalLink className="h-3 w-3" />
                    Открыть пост
                  </a>
                )}
              </Card>
            ))
          )}
        </div>
      </div>
        </>
      )}
    </div>
  );
}

export default function MentionsPage() {
  return (
    <AppShell title="Упоминания" subtitle="Узнавай первым, когда твой бренд или тему обсуждают — и превращай упоминания в клиентов.">
      <MentionsInner />
    </AppShell>
  );
}
