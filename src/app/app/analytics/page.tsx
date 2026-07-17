"use client";

// А11 — Аналитика (ТЗ 5.7, Д.5). Всё из НАСТОЯЩИХ снимков (/api/stats): просмотры и
// реакции постов (публичная страница t.me/s/), рост подписчиков (Bot API). Чего Telegram
// не отдаёт — охват и комментарии — честно помечаем «недоступно», не рисуем ноль.
// Главное — человеческий вывод, а не голые графики (ТЗ 7.5).

import { useCallback, useEffect, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import {
  BarChart3,
  Eye,
  Heart,
  Info,
  RefreshCw,
  Send,
  Sparkles,
  TrendingDown,
  TrendingUp,
  Users,
} from "lucide-react";
import { AppShell } from "@/components/app/shell";
import { ChannelPicker, useChannelChoice } from "@/components/app/channel-picker";
import { Button } from "@/components/ui/button";
import { Badge, Card, EmptyState } from "@/components/ui/primitives";
import { useStore } from "@/lib/store";
import { cn, fmtNum } from "@/lib/utils";

const EASE = [0.22, 1, 0.36, 1] as const;

interface SubPoint {
  snapshot_date: string;
  subscribers: number;
}
interface PostStat {
  id: number;
  text: string;
  published_at: string;
  /** Почему цифр нет: 'ok' | 'gone' (удалён из канала) | 'private' | null (ещё не собрали) */
  stats_state: string | null;
  views: number | null;
  reactions: number | null;
}
interface StatsData {
  hasChannel: boolean;
  channelTitle?: string | null;
  latestSubs?: number | null;
  growth7d?: number;
  subscriberSeries?: SubPoint[];
  posts?: PostStat[];
  totals?: { published: number; totalViews: number; avgViews: number | null };
  bestPost?: { text: string; views: number } | null;
  insight?: string | null;
  available?: { views: boolean; reactions: boolean; reach: boolean; comments: boolean };
  collectedAt?: string | null;
}

function fmtDay(iso: string): string {
  // Берём только календарную дату (YYYY-MM-DD) — без времени и таймзоны, чтобы день был точным.
  return new Date(iso.slice(0, 10) + "T00:00:00").toLocaleDateString("ru-RU", {
    day: "numeric",
    month: "long",
  });
}

/* --------------------------------------------------- ГРАФИК ПОДПИСЧИКОВ */

function SubscriberChart({ series }: { series: SubPoint[] }) {
  if (series.length === 0) {
    return (
      <p className="py-8 text-center text-[14px] text-text-3">
        Снимков ещё нет — нажми «Обновить», и появится первая точка.
      </p>
    );
  }
  if (series.length === 1) {
    return (
      <div className="py-6 text-center">
        <p className="nums text-[40px] leading-none font-extrabold text-gradient">
          {fmtNum(series[0].subscribers)}
        </p>
        <p className="mx-auto mt-2 max-w-md text-[13px] leading-relaxed text-text-3">
          Это настоящее число подписчиков на {fmtDay(series[0].snapshot_date)}. График динамики
          появится, когда наберётся несколько ежедневных снимков — канал ещё молодой.
        </p>
      </div>
    );
  }

  const W = 600;
  const H = 160;
  const pad = 8;
  const vals = series.map((s) => s.subscribers);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const x = (i: number) => pad + (i / (series.length - 1)) * (W - 2 * pad);
  const y = (v: number) => H - pad - ((v - min) / span) * (H - 2 * pad);
  const line = series.map((s, i) => `${x(i)},${y(s.subscribers)}`).join(" ");
  const area = `${pad},${H - pad} ${line} ${W - pad},${H - pad}`;

  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-40 w-full"
        role="img"
        aria-label={`Подписчики: с ${fmtNum(series[0].subscribers)} до ${fmtNum(series[series.length - 1].subscribers)} за ${series.length} дней`}
        preserveAspectRatio="none"
      >
        <defs>
          <linearGradient id="subFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--brand-1)" stopOpacity="0.35" />
            <stop offset="1" stopColor="var(--brand-1)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <polygon points={area} fill="url(#subFill)" />
        <polyline
          points={line}
          fill="none"
          stroke="var(--brand-1)"
          strokeWidth="2.5"
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <div className="mt-1 flex justify-between text-[11px] text-text-3">
        <span>{fmtDay(series[0].snapshot_date)}</span>
        <span>{fmtDay(series[series.length - 1].snapshot_date)}</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- ПЛИТКА */

function Tile({
  icon,
  label,
  value,
  sub,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: "up" | "down";
}) {
  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 text-text-3">
        {icon}
        <span className="text-[13px] font-semibold">{label}</span>
      </div>
      <p className="nums mt-2 text-[26px] leading-none font-extrabold text-text">{value}</p>
      {sub != null && (
        <p
          className={cn(
            "mt-1.5 text-[13px] font-semibold",
            tone === "up" ? "text-success" : tone === "down" ? "text-danger" : "text-text-3",
          )}
        >
          {sub}
        </p>
      )}
    </Card>
  );
}

/* ----------------------------------------------------- СОДЕРЖИМОЕ ЭКРАНА */

function Content({
  data,
  loading,
  onReport,
  sending,
}: {
  data: StatsData | null;
  loading: boolean;
  onReport: () => void;
  sending: boolean;
}) {
  const reduce = useReducedMotion();

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="skeleton h-28 w-full rounded-md" />
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="skeleton h-24 rounded-md" />
          ))}
        </div>
        <div className="skeleton h-56 w-full rounded-md" />
      </div>
    );
  }

  if (!data?.hasChannel) {
    return (
      <Card>
        <EmptyState
          icon={<BarChart3 className="h-6 w-6" aria-hidden />}
          title="Пока нечего показывать"
          body="Подключи канал и опубликуй пост — тогда здесь появятся настоящие просмотры, реакции и рост подписчиков. Ничего зашитого."
        />
      </Card>
    );
  }

  const posts = data.posts ?? [];
  const withViews = posts.filter((p) => p.views != null);
  const bestViews = withViews.length ? Math.max(...withViews.map((p) => p.views ?? 0)) : 0;
  const growth = data.growth7d ?? 0;

  return (
    <div className="space-y-5">
      {/* ВЫВОД НЕДЕЛИ — момент ценности (ТЗ 7.1) */}
      <motion.div
        initial={reduce ? false : { opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: EASE }}
      >
        <div className="glass relative overflow-hidden rounded-lg p-5 sm:p-6">
          <div className="flex items-start gap-4">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-brand-gradient text-white shadow-glow">
              <Sparkles className="h-5 w-5" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[12px] font-bold tracking-wide text-text-3 uppercase">Вывод недели</p>
              <p className="mt-1.5 text-[17px] leading-relaxed font-medium text-text">
                {data.insight ??
                  "Собираю первые цифры. Как только пост наберёт просмотры — покажу, что у тебя работает лучше всего."}
              </p>
            </div>
          </div>
          <div className="mt-4">
            <Button variant="soft" size="sm" onClick={onReport} loading={sending}>
              <Send className="h-4 w-4" aria-hidden />
              Отправить отчёт в бот
            </Button>
          </div>
        </div>
      </motion.div>

      {/* ПЛИТКИ — настоящие числа */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile
          icon={<Users className="h-4 w-4" aria-hidden />}
          label="Подписчики"
          value={data.latestSubs != null ? fmtNum(data.latestSubs) : "—"}
          tone={growth > 0 ? "up" : growth < 0 ? "down" : undefined}
          sub={
            growth !== 0 ? (
              <span className="inline-flex items-center gap-1">
                {growth > 0 ? (
                  <TrendingUp className="h-3.5 w-3.5" aria-hidden />
                ) : (
                  <TrendingDown className="h-3.5 w-3.5" aria-hidden />
                )}
                {growth > 0 ? "+" : ""}
                {growth} за неделю
              </span>
            ) : (
              "за неделю без изменений"
            )
          }
        />
        <Tile
          icon={<BarChart3 className="h-4 w-4" aria-hidden />}
          label="Постов вышло"
          value={fmtNum(data.totals?.published ?? 0)}
        />
        <Tile
          icon={<Eye className="h-4 w-4" aria-hidden />}
          label="Просмотров всего"
          value={fmtNum(data.totals?.totalViews ?? 0)}
        />
        <Tile
          icon={<Eye className="h-4 w-4" aria-hidden />}
          label="Просмотров на пост"
          value={data.totals?.avgViews != null ? fmtNum(data.totals.avgViews) : "—"}
        />
      </div>

      {/* ГРАФИК РОСТА ПОДПИСЧИКОВ — настоящий */}
      <Card className="p-5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-[15px] font-bold text-text">Рост подписчиков</h2>
          <Badge tone="success">настоящие данные</Badge>
        </div>
        <div className="mt-4">
          <SubscriberChart series={data.subscriberSeries ?? []} />
        </div>
      </Card>

      {/* ТВОИ ПОСТЫ — настоящие просмотры и реакции */}
      <Card className="p-5">
        <h2 className="text-[15px] font-bold text-text">Твои посты</h2>
        {posts.length === 0 ? (
          <p className="mt-3 text-[14px] text-text-2">
            Опубликованных постов пока нет — как выйдет первый, здесь появятся его цифры.
          </p>
        ) : (
          <ul className="mt-4 space-y-3">
            {posts.slice(0, 8).map((p) => {
              const top = p.views != null && p.views === bestViews && bestViews > 0;
              return (
                <li key={p.id} className="rounded-sm border border-line bg-surface p-3.5">
                  <p className="line-2 text-[14px] leading-snug text-text">{p.text}</p>
                  <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[13px]">
                    {p.views != null ? (
                      <>
                        <span className="nums inline-flex items-center gap-1.5 font-semibold text-text-2">
                          <Eye className="h-4 w-4 text-text-3" aria-hidden />
                          {fmtNum(p.views)}
                        </span>
                        <span className="nums inline-flex items-center gap-1.5 font-semibold text-text-2">
                          <Heart className="h-4 w-4 text-text-3" aria-hidden />
                          {p.reactions != null ? fmtNum(p.reactions) : "реакции выключены"}
                        </span>
                        {top && <Badge tone="fire">лучший по просмотрам</Badge>}
                      </>
                    ) : (
                      // Голое «недоступно» ничего не объясняло: человек не понимал, сломалось
                      // это или он сам удалил пост. Причину знает воркер — показываем её.
                      <span className="inline-flex items-center gap-1.5 text-text-3">
                        <Eye className="h-4 w-4" aria-hidden />
                        {p.stats_state === "gone"
                          ? "пост удалён из канала — Telegram больше не отдаёт его цифры"
                          : p.stats_state === "private"
                            ? "у канала нет публичного адреса — просмотров не будет"
                            : "цифры ещё не собрали — обычно появляются в течение суток"}
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {/* ЧЕСТНОСТЬ — что Telegram не отдаёт */}
      <div className="flex items-start gap-2.5 rounded-md bg-surface-inset p-4">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-text-3" aria-hidden />
        <p className="text-[13px] leading-relaxed text-text-2">
          Показываем то, что Telegram реально отдаёт:{" "}
          <b className="font-semibold text-text">просмотры</b> и{" "}
          <b className="font-semibold text-text">реакции</b> (с публичной страницы канала) и{" "}
          <b className="font-semibold text-text">подписчиков</b>. Охват и комментарии Telegram по
          каналу не отдаёт — поэтому мы честно пишем «недоступно», а не рисуем ноль или выдумку.
          {data.collectedAt && (
            <>
              {" "}
              Последний сбор:{" "}
              {new Date(data.collectedAt).toLocaleString("ru-RU", { timeZone: "Europe/Moscow" })} МСК.
            </>
          )}
        </p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- ЭКРАН */

export default function AnalyticsPage() {
  const s = useStore();
  const [data, setData] = useState<StatsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [sending, setSending] = useState(false);
  const [picked, setPicked] = useState<number | null>(null);

  // Аналитика — про ОДИН канал: «лучшее время» и «что зашло» существуют только внутри
  // одной аудитории. Раньше сервер складывал все каналы в одну кучу и выводы врали обоим.
  const { tgChannels, channelId } = useChannelChoice(s.realChannels, picked);

  const load = useCallback(async () => {
    if (!channelId) return;
    try {
      const r = await fetch(`/api/stats?channel=${channelId}`, { cache: "no-store" });
      setData((await r.json()) as StatsData);
    } catch {
      /* оставим как было */
    } finally {
      setLoading(false);
    }
  }, [channelId]);

  useEffect(() => {
    // Загрузка данных с сервера — side-effect; setState внутри async-колбэка.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- запрос /api/stats при монтировании
    load();
  }, [load]);

  const refresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await fetch("/api/stats/collect", { method: "POST" });
      // сбор делает воркер — даём ему пару секунд, потом перечитываем
      await new Promise((r) => setTimeout(r, 2800));
      await load();
      s.toast({
        kind: "success",
        title: "Цифры обновлены",
        body: "Собрал свежую статистику из Telegram.",
      });
    } finally {
      setRefreshing(false);
    }
  }, [refreshing, load, s]);

  const sendReport = useCallback(async () => {
    if (sending) return;
    setSending(true);
    try {
      const r = await fetch("/api/stats/report", { method: "POST" });
      if (r.ok) {
        s.toast({
          kind: "success",
          title: "Отчёт отправлен в бот",
          body: "Загляни в Telegram — недельная сводка одной страницей уже там.",
        });
      }
    } finally {
      setSending(false);
    }
  }, [sending, s]);

  return (
    <AppShell
      title="Аналитика"
      subtitle="Настоящие цифры твоих постов — и что с ними делать. За минуту, без объяснений."
      action={
        <Button variant="brand" size="md" onClick={refresh} loading={refreshing}>
          <RefreshCw className="h-4 w-4" aria-hidden />
          Обновить
        </Button>
      }
    >
      {/* Цифры и выводы — про один канал за раз. Иначе «лучшее время» усредняется
          по разным аудиториям и оказывается неверным сразу для всех. */}
      <ChannelPicker
        channels={tgChannels}
        value={channelId}
        onChange={setPicked}
        label="Аналитика канала"
        className="mb-6"
      />

      <Content data={data} loading={loading} onReport={sendReport} sending={sending} />
    </AppShell>
  );
}
