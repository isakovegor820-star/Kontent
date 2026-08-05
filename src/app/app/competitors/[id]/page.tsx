"use client";

// А7. ДОСЬЕ КОНКУРЕНТА (ТЗ 5.4, Д.6). Разведка по ОТКРЫТЫМ данным t.me/s/ + Bot API.
//
// Задача экрана — не показать цифры, а ответить: что у него работает и что мне с этим
// делать. Поэтому кроме сводки тут ритм (когда постит), медиа-микс и длина (что заходит)
// и анатомия залёта (что общего у его лучших постов).
//
// Честность: реакции t.me/s/ почти не отдаёт — если их нет, не показываем ни ER, ни
// пустые прочерки, а прямо пишем, чего открытые данные не дают. На мелких каналах
// (медиана в единицы просмотров) статистика — шум, и мы говорим об этом первым делом.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { motion, useReducedMotion } from "motion/react";
import {
  ArrowLeft,
  Eye,
  ExternalLink,
  Flame,
  Gauge,
  Info,
  Radar,
  TrendingUp,
  TriangleAlert,
  Users,
} from "lucide-react";

import { AppShell } from "@/components/app/shell";
import { Button } from "@/components/ui/button";
import { Badge, Card, TelegramIcon } from "@/components/ui/primitives";
import { cn, fmtCompact, fmtNum, plural, weekdayShort } from "@/lib/utils";

const EASE = [0.22, 1, 0.36, 1] as const;

interface DossierPost {
  msgId: number;
  text: string | null;
  views: number | null;
  media: string;
  isHit: boolean;
  ratio: number | null;
  postedAt: string | null;
  link: string;
}
interface Bucket {
  label: string;
  posts: number;
  avgViews: number | null;
}
interface Dossier {
  competitor: {
    id: number;
    handle: string;
    title: string | null;
    subscribers: number | null;
    status: string;
    lastError: string | null;
    collectedAt: string | null;
    link: string;
  };
  stats: {
    postsCount: number;
    withViews: number;
    avgViews: number | null;
    medianViews: number | null;
    erPct: number | null;
    reachPct: number | null;
    perWeek: number | null;
    bestHour: number | null;
    growth: number | null;
    thinData: boolean;
    thinReason: string | null;
  };
  rhythm: {
    byWeekday: { day: number; posts: number; avgViews: number | null }[];
    byHour: { hour: number; posts: number; avgViews: number | null }[];
  };
  mediaMix: { media: string; label: string; posts: number; share: number; avgViews: number | null }[];
  lengthBuckets: Bucket[];
  hitAnatomy: {
    count: number;
    avgLen: number | null;
    restAvgLen: number | null;
    media: { media: string; label: string; count: number } | null;
    hours: number[];
    avgRatio: number | null;
  } | null;
  subscriberSeries: { date: string; subscribers: number }[];
  topPosts: DossierPost[];
  available: { views: boolean; reactions: boolean; reposts: boolean; comments: boolean };
  aiInsight: string | null;
}

const MEDIA_EMOJI: Record<string, string> = { text: "📝", photo: "🖼️", video: "🎬" };
const hh = (h: number) => `${String(h).padStart(2, "0")}:00`;

/* ----------------------------------------------------------------- кусочки */

function Tile({
  icon,
  label,
  value,
  sub,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  sub?: string;
}) {
  return (
    <Card className="p-4">
      <p className="flex items-center gap-1.5 text-[12px] font-semibold text-text-3">
        {icon}
        {label}
      </p>
      <p className="nums mt-1 text-[22px] leading-none font-extrabold text-text">{value}</p>
      {sub && <p className="mt-1.5 text-[12px] leading-snug text-text-3">{sub}</p>}
    </Card>
  );
}

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <Card className="p-4 sm:p-5">
      <h2 className="text-[15px] font-bold text-text">{title}</h2>
      {hint && <p className="mt-0.5 text-[13px] leading-relaxed text-text-3">{hint}</p>}
      <div className="mt-4">{children}</div>
    </Card>
  );
}

/** Горизонтальная полоска: подпись — шкала — значение. Без графических библиотек. */
function BarRow({
  label,
  value,
  max,
  note,
  highlight,
}: {
  label: string;
  value: number;
  max: number;
  note?: string;
  highlight?: boolean;
}) {
  const pct = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
  return (
    <div className="flex items-center gap-3">
      <span
        className={cn(
          "w-16 shrink-0 text-[12px] font-semibold",
          highlight ? "text-brand" : "text-text-3",
        )}
      >
        {label}
      </span>
      <span className="h-2.5 flex-1 overflow-hidden rounded-full bg-surface-inset">
        <span
          className={cn("block h-full rounded-full", highlight ? "bg-brand-gradient" : "bg-brand/35")}
          style={{ width: `${pct}%` }}
        />
      </span>
      <span className="nums w-24 shrink-0 text-right text-[12px] text-text-3">{note}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ экран */

export default function DossierPage() {
  const params = useParams<{ id: string }>();
  const reduce = useReducedMotion();
  const id = params?.id;
  const [d, setD] = useState<Dossier | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const r = await fetch(`/api/competitors/${id}`, { cache: "no-store" });
      if (r.ok) setD((await r.json()) as Dossier);
    } catch {
      /* сеть */
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- загрузка при монтировании
    load();
  }, [load]);

  if (loading) {
    return (
      <AppShell title="Досье">
        <div className="space-y-4">
          <div className="skeleton h-24 rounded-lg" />
          <div className="skeleton h-64 rounded-lg" />
        </div>
      </AppShell>
    );
  }

  if (!d) {
    return (
      <AppShell title="Досье">
        <Card className="p-8 text-center">
          <p className="text-[15px] font-semibold text-text">Досье не найдено</p>
          <div className="mt-4">
            <Link href="/app/competitors">
              <Button variant="solid">К конкурентам</Button>
            </Link>
          </div>
        </Card>
      </AppShell>
    );
  }

  const { competitor: c, stats: s, rhythm, mediaMix, lengthBuckets, hitAnatomy, available } = d;
  const dead = c.status === "error" || c.status === "no_feed";

  const maxWeekday = Math.max(...rhythm.byWeekday.map((x) => x.posts), 1);
  const maxHour = Math.max(...rhythm.byHour.map((x) => x.posts), 1);
  const maxMedia = Math.max(...mediaMix.map((m) => m.avgViews ?? 0), 1);
  const maxLen = Math.max(...lengthBuckets.map((b) => b.avgViews ?? 0), 1);
  const bestMedia = [...mediaMix].sort((a, b) => (b.avgViews ?? 0) - (a.avgViews ?? 0))[0];
  const bestLen = [...lengthBuckets].sort((a, b) => (b.avgViews ?? 0) - (a.avgViews ?? 0))[0];

  return (
    <AppShell
      title={c.title || `@${c.handle}`}
      subtitle="Разведка по открытым данным Telegram: что у него работает и что с этим делать."
      action={
        <Link href="/app/competitors">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="h-4 w-4" aria-hidden />
            К конкурентам
          </Button>
        </Link>
      }
    >
      <motion.div
        initial={reduce ? false : { opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, ease: EASE }}
        className="space-y-5"
      >
        {/* Шапка канала */}
        <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
          <div className="flex min-w-0 items-center gap-2 text-text-3">
            <TelegramIcon className="h-4 w-4" />
            <span className="truncate text-[13px] font-semibold">@{c.handle}</span>
            {c.collectedAt && (
              <span className="text-[12px] text-text-3">
                · собрано{" "}
                {new Date(c.collectedAt).toLocaleString("ru-RU", {
                  day: "numeric",
                  month: "short",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
            )}
          </div>
          <a href={c.link} target="_blank" rel="noopener noreferrer">
            <Button variant="ghost" size="sm">
              <ExternalLink className="h-4 w-4" aria-hidden />
              Открыть канал
            </Button>
          </a>
        </Card>

        {/* Канал не читается — дальше показывать нечего, и врать не будем */}
        {dead ? (
          <Card className="p-8 text-center">
            <TriangleAlert className="mx-auto h-7 w-7 text-danger" aria-hidden />
            <p className="mt-3 text-[15px] font-semibold text-text">Досье собрать не из чего</p>
            <p className="mx-auto mt-1 max-w-md text-[14px] leading-relaxed text-text-3">
              {c.lastError || "Канал не отдаёт посты публично."}
            </p>
          </Card>
        ) : (
          <>
            {/* ЧЕСТНОСТЬ ПЕРВЫМ ДЕЛОМ: на мелкой выборке всё ниже — шум */}
            {s.thinData && (
              <div className="flex items-start gap-3 rounded-lg bg-surface-inset p-4">
                <TriangleAlert className="mt-0.5 h-5 w-5 shrink-0 text-text-3" aria-hidden />
                <p className="text-[14px] leading-relaxed text-text-2">
                  <span className="font-semibold text-text">Данных мало — выводам верить рано. </span>
                  {s.thinReason} Цифры ниже показываю как есть, но в контент-план такие темы не
                  отдаю: план получится случайным.
                </p>
              </div>
            )}

            {/* Сводка */}
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Tile
                icon={<Users className="h-3.5 w-3.5" aria-hidden />}
                label="Подписчики"
                value={c.subscribers != null ? fmtCompact(c.subscribers) : "—"}
                sub={
                  s.growth != null && s.growth !== 0
                    ? `${s.growth > 0 ? "+" : "−"}${fmtNum(Math.abs(s.growth))} за период наблюдения`
                    : "динамика ещё копится"
                }
              />
              <Tile
                icon={<Eye className="h-3.5 w-3.5" aria-hidden />}
                label="Норма просмотров"
                value={s.medianViews != null ? fmtCompact(s.medianViews) : "—"}
                sub={s.avgViews != null ? `среднее — ${fmtCompact(s.avgViews)}` : undefined}
              />
              <Tile
                icon={<Gauge className="h-3.5 w-3.5" aria-hidden />}
                label="Смотрит подписчиков"
                value={s.reachPct != null ? `${s.reachPct}%` : "—"}
                sub="просмотры к подписчикам"
              />
              <Tile
                icon={<TrendingUp className="h-3.5 w-3.5" aria-hidden />}
                label="Постов в неделю"
                value={s.perWeek != null ? s.perWeek : "—"}
                sub={s.bestHour != null ? `лучший час — ${hh(s.bestHour)} МСК` : "лучший час пока не ясен"}
              />
            </div>

            {/* Анатомия залёта — главный ответ «что у него сработало» */}
            {hitAnatomy && (
              <Section
                title={`Анатомия залёта — ${hitAnatomy.count} ${plural(hitAnatomy.count, "пост", "поста", "постов")}`}
                hint="Что общего у его лучших постов. Залёт считается от его же нормы: верхние 10% канала и минимум ×1,5 к медиане."
              >
                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="rounded-lg bg-surface-inset p-3">
                    <p className="text-[12px] font-semibold text-text-3">Сила залёта</p>
                    <p className="nums mt-1 text-[18px] font-extrabold text-text">
                      ×{hitAnatomy.avgRatio ?? "—"}
                    </p>
                    <p className="mt-1 text-[12px] text-text-3">в среднем к норме канала</p>
                  </div>
                  <div className="rounded-lg bg-surface-inset p-3">
                    <p className="text-[12px] font-semibold text-text-3">Длина</p>
                    <p className="nums mt-1 text-[18px] font-extrabold text-text">
                      {hitAnatomy.avgLen != null ? `${hitAnatomy.avgLen} зн.` : "—"}
                    </p>
                    <p className="mt-1 text-[12px] text-text-3">
                      {hitAnatomy.avgLen != null && hitAnatomy.restAvgLen != null
                        ? hitAnatomy.avgLen > hitAnatomy.restAvgLen
                          ? `длиннее обычных (${hitAnatomy.restAvgLen} зн.)`
                          : `короче обычных (${hitAnatomy.restAvgLen} зн.)`
                        : "не с чем сравнить"}
                    </p>
                  </div>
                  <div className="rounded-lg bg-surface-inset p-3">
                    <p className="text-[12px] font-semibold text-text-3">Формат</p>
                    <p className="mt-1 text-[18px] font-extrabold text-text">
                      {hitAnatomy.media
                        ? `${MEDIA_EMOJI[hitAnatomy.media.media] ?? ""} ${hitAnatomy.media.label}`
                        : "—"}
                    </p>
                    <p className="mt-1 text-[12px] text-text-3">
                      {hitAnatomy.hours.length
                        ? `выходили в ${hitAnatomy.hours.map(hh).join(", ")} МСК`
                        : "время не определилось"}
                    </p>
                  </div>
                </div>
              </Section>
            )}

            {/* Ритм: дни и часы */}
            <Section
              title="Когда постит"
              hint="Дни недели и часы по МСК — видно его расписание и когда он ловит просмотры."
            >
              <div className="space-y-2">
                {rhythm.byWeekday.map((w) => (
                  <BarRow
                    key={w.day}
                    label={weekdayShort(w.day) ?? ""}
                    value={w.posts}
                    max={maxWeekday}
                    note={w.posts ? `${w.posts} ${plural(w.posts, "пост", "поста", "постов")}` : "—"}
                  />
                ))}
              </div>

              <div className="mt-5">
                <p className="mb-2 text-[12px] font-semibold text-text-3">Часы выхода (МСК)</p>
                <div className="flex items-end gap-[3px]">
                  {rhythm.byHour.map((h) => {
                    const best = s.bestHour === h.hour;
                    const height = h.posts ? Math.max(6, Math.round((h.posts / maxHour) * 44)) : 2;
                    return (
                      <span
                        key={h.hour}
                        title={`${hh(h.hour)} — ${h.posts} ${plural(h.posts, "пост", "поста", "постов")}${
                          h.avgViews != null ? `, в среднем ${fmtCompact(h.avgViews)} просмотров` : ""
                        }`}
                        className={cn(
                          "flex-1 rounded-sm",
                          h.posts === 0 ? "bg-surface-inset" : best ? "bg-brand-gradient" : "bg-brand/35",
                        )}
                        style={{ height: `${height}px` }}
                      />
                    );
                  })}
                </div>
                <div className="mt-1.5 flex justify-between text-[11px] text-text-3">
                  <span>00</span>
                  <span>06</span>
                  <span>12</span>
                  <span>18</span>
                  <span>23</span>
                </div>
                {s.bestHour != null && (
                  <p className="mt-2 text-[12px] text-text-3">
                    Больше всего просмотров в среднем — в{" "}
                    <span className="font-semibold text-brand">{hh(s.bestHour)}</span> МСК.
                  </p>
                )}
              </div>
            </Section>

            {/* Что заходит: формат и длина */}
            <div className="grid gap-5 lg:grid-cols-2">
              {mediaMix.length > 0 && (
                <Section
                  title="Какой формат заходит"
                  hint={
                    bestMedia?.avgViews != null
                      ? `Лучше всего — «${bestMedia.label}»: ${fmtCompact(bestMedia.avgViews)} просмотров в среднем.`
                      : undefined
                  }
                >
                  <div className="space-y-2.5">
                    {mediaMix.map((m) => (
                      <BarRow
                        key={m.media}
                        label={`${MEDIA_EMOJI[m.media] ?? ""} ${m.share}%`}
                        value={m.avgViews ?? 0}
                        max={maxMedia}
                        highlight={bestMedia?.media === m.media}
                        note={m.avgViews != null ? `${fmtCompact(m.avgViews)} просм.` : "—"}
                      />
                    ))}
                  </div>
                </Section>
              )}

              {lengthBuckets.length > 0 && (
                <Section
                  title="Какая длина заходит"
                  hint={bestLen?.avgViews != null ? `Лучше всего — посты «${bestLen.label}» знаков.` : undefined}
                >
                  <div className="space-y-2.5">
                    {lengthBuckets.map((b) => (
                      <BarRow
                        key={b.label}
                        label={b.label}
                        value={b.avgViews ?? 0}
                        max={maxLen}
                        highlight={bestLen?.label === b.label}
                        note={b.avgViews != null ? `${fmtCompact(b.avgViews)} просм.` : "—"}
                      />
                    ))}
                  </div>
                </Section>
              )}
            </div>

            {/* Лучшие посты */}
            <Section title="Лучшие посты" hint="Отсортированы по просмотрам. Залёты помечены огнём.">
              <ul className="space-y-3">
                {d.topPosts.map((p) => (
                  <li key={p.msgId}>
                    <a
                      href={p.link}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block rounded-lg bg-surface-inset p-3 transition-opacity hover:opacity-80"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="nums text-[13px] font-bold text-text">
                          {p.views != null ? fmtCompact(p.views) : "—"} просмотров
                        </span>
                        {p.isHit && (
                          <Badge tone="fire">
                            <Flame className="h-3 w-3" aria-hidden />×{p.ratio} к норме
                          </Badge>
                        )}
                        <span className="text-[12px] text-text-3">
                          {MEDIA_EMOJI[p.media] ?? ""}{" "}
                          {p.postedAt
                            ? new Date(p.postedAt).toLocaleDateString("ru-RU", {
                                timeZone: "Europe/Moscow",
                                day: "numeric",
                                month: "short",
                              })
                            : ""}
                        </span>
                        <ExternalLink className="ml-auto h-3.5 w-3.5 text-text-3" aria-hidden />
                      </div>
                      {p.text && (
                        <p className="mt-1.5 line-clamp-2 text-[13px] leading-relaxed text-text-2">
                          {p.text}
                        </p>
                      )}
                    </a>
                  </li>
                ))}
                {d.topPosts.length === 0 && (
                  <li className="text-[13px] text-text-3">Постов с просмотрами пока не собрано.</li>
                )}
              </ul>
            </Section>
          </>
        )}

        {/* Чего открытые данные не дают — честно, а не прочерками */}
        <div className="flex items-start gap-3 rounded-lg bg-surface-inset p-4">
          <Info className="mt-0.5 h-5 w-5 shrink-0 text-text-3" aria-hidden />
          <div className="text-[13px] leading-relaxed text-text-3">
            <p>
              <span className="font-semibold text-text-2">Собираем только открытое: </span>
              текст постов, просмотры, время выхода, тип вложения, подписчиков.
            </p>
            <p className="mt-1">
              <span className="font-semibold text-text-2">Не даёт Telegram: </span>
              {!available.reactions && "реакции (в публичной ленте их нет), "}
              пересылки, комментарии, охват, демографию аудитории и расходы на рекламу. Мы этого не
              показываем — не потому что не собрали, а потому что таких данных нет.
            </p>
          </div>
        </div>

        {/* Словесный разбор ИИ живёт в «Трендах» (Д.7: идея публикации) */}
        {d.aiInsight === null && !dead && (
          <div className="flex items-start gap-3 rounded-lg bg-info-soft p-4">
            <Radar className="mt-0.5 h-5 w-5 shrink-0 text-brand" aria-hidden />
            <p className="text-[13px] leading-relaxed text-text-2">
              <span className="font-semibold text-text">Разбор залётов с ИИ — в «Трендах». </span>
              Там платформа объясняет, почему пост зашёл, и даёт кнопку «Создать публикацию» — тема уедет в
              автопилот.
              <Link href="/app/trends" className="ml-1 font-semibold text-brand hover:underline">
                Открыть тренды →
              </Link>
            </p>
          </div>
        )}
      </motion.div>
    </AppShell>
  );
}
