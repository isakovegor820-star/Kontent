"use client";

/**
 * А12 — НАСТРОЙКИ (Приложение А).
 *
 * Всё, чем платформа распоряжается от твоего имени, собрано на одном экране:
 * сети (ТЗ 5.2), бот (5.9), автопилот (5.6), тихие часы, режим соло/команда (5.10)
 * и честный лимит ИИ (раздел 6 «честность лимитов», риск 12 «стоимость ИИ»).
 *
 * Экран спокойный (ТЗ 7.1): ни одной градиентной кнопки-магнита — у настроек нет
 * главного действия, и выдумывать его не нужно. Каждая секция — карточка с
 * заголовком, объяснением и большим полем воздуха вокруг.
 *
 * Сохранение мгновенное: стор сам пишет в localStorage. Тост «Сохранили» показываем
 * только на важном (режим, ниша, тон, доверие автопилоту) — не на каждый щелчок.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  Bot,
  Check,
  Clock,
  Link2,
  Lock,
  LogOut,
  Moon,
  Plus,
  Rocket,
  RotateCcw,
  Sparkles,
  TriangleAlert,
  User,
  Users,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { AppShell } from "@/components/app/shell";
import { Button } from "@/components/ui/button";
import {
  Badge,
  Card,
  Divider,
  EmptyState,
  Field,
  Input,
  TelegramIcon,
  Textarea,
  Toggle,
  VkIcon,
} from "@/components/ui/primitives";
import { useStore } from "@/lib/store";
import type { Channel, Settings as SettingsData } from "@/lib/types";
import { NETWORK_LABEL, cn, fmtCompact, fmtNum, plural } from "@/lib/utils";

const EASE = [0.22, 1, 0.36, 1] as const;

/** Короткий отклик на важное изменение. Стор уже сохранил — просто подтверждаем. */
function useSaved() {
  const { toast } = useStore();
  return () => toast({ kind: "info", title: "Сохранили" });
}

/* --------------------------------------------------------------- СЕКЦИЯ */
// Единая рамка для всех блоков: иконка, заголовок, объяснение — и тело.
// Опасная зона рисуется тем же кирпичом, но красной каймой и вручную:
// у Card граница задана сокращением `border`, и её цвет не перебить утилитой.

function Section({
  icon: Icon,
  title,
  description,
  index,
  danger,
  className,
  children,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  index: number;
  danger?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const reduce = useReducedMotion();

  const inner = (
    <>
      <div className="flex items-start gap-3.5 border-b border-line px-6 py-5 sm:px-7">
        <span
          aria-hidden
          className={cn(
            "grid h-10 w-10 shrink-0 place-items-center rounded-sm",
            danger ? "bg-danger-soft text-danger-text" : "bg-surface-inset text-text-2",
          )}
        >
          <Icon className="h-5 w-5" strokeWidth={1.75} />
        </span>
        <div className="min-w-0">
          <h2 className="text-[17px] font-extrabold tracking-tight text-text">{title}</h2>
          <p className="mt-1 text-[14px] leading-relaxed text-text-2">{description}</p>
        </div>
      </div>
      <div className="px-6 py-6 sm:px-7 sm:py-7">{children}</div>
    </>
  );

  return (
    <motion.section
      initial={{ opacity: 0, y: 12 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-60px" }}
      transition={
        reduce ? { duration: 0 } : { duration: 0.42, ease: EASE, delay: Math.min(index * 0.05, 0.2) }
      }
      className={className}
    >
      {danger ? (
        <div className="overflow-hidden rounded-md border border-danger/30 bg-surface shadow-soft">
          {inner}
        </div>
      ) : (
        <Card className="overflow-hidden">{inner}</Card>
      )}
    </motion.section>
  );
}

/* ------------------------------------------------------- 1. СЕТИ (ТЗ 5.2) */

function ChannelsSection({ index }: { index: number }) {
  const s = useStore();
  // Отключение живёт в этом сеансе: в демо мы не трогаем сам список каналов,
  // но кнопка обязана работать по-настоящему — и работает.
  const [offline, setOffline] = useState<string[]>([]);
  const [asking, setAsking] = useState<string | null>(null);

  const disconnect = (ch: Channel) => {
    setOffline((prev) => (prev.includes(ch.id) ? prev : [...prev, ch.id]));
    setAsking(null);
    s.toast({
      kind: "info",
      title: "Сеть отключена",
      body: `«${ch.name}» в ${NETWORK_LABEL[ch.network]} больше не публикует. Подключить обратно можно здесь же.`,
    });
  };

  const reconnect = (ch: Channel) => {
    setOffline((prev) => prev.filter((id) => id !== ch.id));
    s.toast({
      kind: "success",
      title: "Сеть снова на связи",
      body: `«${ch.name}» в ${NETWORK_LABEL[ch.network]} снова публикует по расписанию.`,
    });
  };

  const addMore = () =>
    s.toast({
      kind: "info",
      title: "Подключи канал или сообщество",
      body: "Telegram-канал — через бота-администратора в мастере первого запуска. VK-сообщество — по ключу доступа в блоке ниже.",
    });

  return (
    <Section
      icon={Link2}
      index={index}
      title="Подключённые сети"
      description="Отсюда посты уходят сами — компьютер держать включённым не нужно."
    >
      {s.channels.length === 0 ? (
        <EmptyState
          icon={<Link2 className="h-6 w-6" strokeWidth={1.75} />}
          title="Ни одной сети"
          body="Подключи Telegram или VK — без этого посты некуда отправлять."
          action={
            <Button variant="outline" onClick={addMore}>
              <Plus className="h-[18px] w-[18px]" strokeWidth={2} aria-hidden />
              Подключить сеть
            </Button>
          }
        />
      ) : (
        <ul className="space-y-3">
          {s.channels.map((ch) => {
            const live = ch.connected && !offline.includes(ch.id);
            const Glyph = ch.network === "tg" ? TelegramIcon : VkIcon;

            return (
              <li key={ch.id} className="rounded-sm border border-line bg-surface-2 p-4">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
                  <span
                    aria-hidden
                    className={cn(
                      "grid h-11 w-11 shrink-0 place-items-center rounded-full transition-colors duration-200",
                      live ? "bg-info-soft text-brand" : "bg-surface-inset text-text-3",
                    )}
                  >
                    <Glyph className="h-5 w-5" />
                  </span>

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <p className="truncate text-[15px] font-bold text-text">{ch.name}</p>
                      <Badge tone="neutral">{NETWORK_LABEL[ch.network]}</Badge>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1">
                      <span className="truncate font-mono text-[13px] text-text-3">{ch.handle}</span>
                      <span aria-hidden className="h-1 w-1 rounded-full bg-line-strong" />
                      <span className="nums text-[13px] text-text-2">
                        {fmtCompact(ch.subscribers)}{" "}
                        {plural(ch.subscribers, "подписчик", "подписчика", "подписчиков")}
                      </span>
                    </div>
                  </div>

                  {live ? (
                    <div className="flex items-center gap-2">
                      <Badge tone="success">
                        <Check className="h-3.5 w-3.5" strokeWidth={3} aria-hidden />
                        Подключён
                      </Badge>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setAsking(ch.id)}
                        aria-expanded={asking === ch.id}
                      >
                        Отключить
                      </Button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <Badge tone="neutral">Отключён</Badge>
                      <Button variant="outline" size="sm" onClick={() => reconnect(ch)}>
                        Подключить снова
                      </Button>
                    </div>
                  )}
                </div>

                {/* Подтверждение строкой — без модалок: видно, что именно отключаем */}
                <AnimatePresence initial={false}>
                  {asking === ch.id && live && (
                    <motion.div
                      key="ask"
                      initial={{ opacity: 0, y: -6 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -6 }}
                      transition={{ duration: 0.22, ease: EASE }}
                      className="mt-4 rounded-sm border border-danger/30 bg-danger-soft p-4"
                    >
                      <p className="text-[15px] leading-relaxed font-bold text-danger-text">
                        Отключить «{ch.name}»? Запланированные посты в эту сеть не выйдут.
                      </p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <Button variant="danger" size="sm" onClick={() => disconnect(ch)}>
                          Отключить
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setAsking(null)}>
                          Отмена
                        </Button>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </li>
            );
          })}
        </ul>
      )}

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <Button variant="outline" onClick={addMore}>
          <Plus className="h-[18px] w-[18px]" strokeWidth={2} aria-hidden />
          Подключить ещё
        </Button>
      </div>

      <Divider className="my-6" />

      {/* Настоящее подключение VK-сообщества (аналог TG bot-link): ключ доступа сообщества. */}
      <VkConnect />

      {/* ТЗ 9: токены — только зашифрованными; никаких публикаций без ведома пользователя */}
      <p className="mt-5 flex items-start gap-2 text-[13px] leading-relaxed text-text-3">
        <Lock className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={1.75} aria-hidden />
        Токены хранятся зашифрованными. Ни один пост не уйдёт без твоего ведома.
      </p>
    </Section>
  );
}

/* ----------------------------------------- 1б. ПОДКЛЮЧЕНИЕ VK-СООБЩЕСТВА */

/**
 * Настоящее подключение VK (аналог TG bot-link). Админ сообщества создаёт в VK ключ
 * доступа с правом «Стена» (Управление → Работа с API) и вставляет его сюда. Сервер
 * проверяет ключ на живом API, шифрует (AES-GCM) и сохраняет сообщество как канал.
 */
function vkConnectError(code?: string): string {
  switch (code) {
    case "invalid_token":
      return "Ключ не подошёл. Проверь, что создал ключ сообщества (не личный) и включил право «Стена».";
    case "taken":
      return "Это сообщество уже подключено к другому аккаунту Авроры.";
    case "empty":
      return "Вставь ключ доступа сообщества.";
    case "server":
      return "Сервер не смог зашифровать ключ. Напиши в поддержку.";
    case "unauthorized":
      return "Сессия истекла — зайди заново.";
    default:
      return "Не получилось подключить. Попробуй ещё раз.";
  }
}

function VkConnect() {
  const s = useStore();
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const vkChannels = s.realChannels.filter((c) => c.network === "vk" && c.is_active);

  const connect = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    const res = await s.connectVkChannel(token.trim());
    setBusy(false);
    if (res.ok) {
      s.toast({
        kind: "success",
        title: `Сообщество «${res.title ?? "VK"}» подключено`,
        body: "Теперь сюда можно постить с сервера.",
      });
      setToken("");
    } else {
      setError(vkConnectError(res.error));
    }
  };

  return (
    <div className="rounded-md bg-surface-inset p-4">
      <p className="flex items-center gap-2 text-[15px] font-semibold text-text">
        <VkIcon className="h-5 w-5 text-brand" />
        VK-сообщество
      </p>
      <p className="mt-1.5 text-[14px] leading-relaxed text-text-2">
        Публикация в VK работает так же, как в Telegram: сервер постит сам. В сообществе зайди в{" "}
        <b className="font-semibold text-text">Управление → Работа с API</b> → «Создать ключ» и
        включи право <b className="font-semibold text-text">«Стена»</b>, затем вставь ключ сюда.
      </p>

      {vkChannels.length > 0 && (
        <ul className="mt-3 space-y-2">
          {vkChannels.map((ch) => (
            <li
              key={ch.id}
              className="flex items-center gap-2.5 rounded-sm border border-line bg-surface px-3 py-2"
            >
              <VkIcon className="h-4 w-4 shrink-0 text-brand" />
              <span className="min-w-0 flex-1 truncate text-[14px] font-semibold text-text">
                {ch.title ?? ch.handle ?? "Сообщество"}
              </span>
              <Badge tone="success">
                <Check className="h-3.5 w-3.5" strokeWidth={3} aria-hidden />
                Подключено
              </Badge>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={connect} className="mt-3 flex flex-col gap-2 sm:flex-row">
        <Input
          value={token}
          disabled={busy}
          type="password"
          autoComplete="off"
          placeholder="Ключ доступа сообщества"
          aria-label="Ключ доступа VK-сообщества"
          aria-invalid={error ? true : undefined}
          onChange={(e) => {
            setToken(e.target.value);
            if (error) setError(null);
          }}
        />
        <Button type="submit" variant="outline" loading={busy} className="shrink-0">
          <VkIcon className="h-4 w-4" aria-hidden />
          Подключить VK
        </Button>
      </form>
      {error && (
        <p role="alert" className="mt-2 text-[13px] leading-relaxed font-medium text-danger-text">
          {error}
        </p>
      )}
    </div>
  );
}

/* -------------------------------------------------- 2. БОТ (ТЗ 5.9, Прил. В) */

/**
 * Настоящая привязка бота. Раньше здесь стоял тумблер «Бот привязан», который жил в
 * localStorage и ничего не привязывал — просто рисовал картинку переписки. Теперь:
 * кабинет выдаёт одноразовую ссылку → человек жмёт /start → бот запоминает ЕГО чат.
 * Без этого уведомления уходили в один общий чат владельца, а не автору канала.
 */
function BotLink() {
  const s = useStore();
  const [linked, setLinked] = useState<boolean | null>(null);
  const [bot, setBot] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    fetch("/api/bot/link", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { linked?: boolean; bot?: string | null } | null) => {
        if (!d) return;
        setLinked(!!d.linked);
        setBot(d.bot ?? null);
      })
      .catch(() => setLinked(false));
  }, []);
  useEffect(load, [load]);

  const connect = async () => {
    setBusy(true);
    try {
      const r = await fetch("/api/bot/link", { method: "POST" });
      const d = (await r.json()) as { ok?: boolean; url?: string; error?: string; needs?: string };
      if (d.error === "bot_not_configured") {
        s.toast({
          kind: "info",
          title: "Бот ещё не настроен",
          body: `Нужно имя бота в ${d.needs} — без него ссылку не собрать.`,
        });
        return;
      }
      if (d.ok && d.url) {
        window.open(d.url, "_blank", "noopener");
        s.toast({
          kind: "info",
          title: "Открыл Telegram",
          body: "Нажми «Начать» в чате с ботом — и вернись сюда, я подхвачу.",
        });
        // Ссылка одноразовая: человек жмёт /start в Telegram, а мы ждём и проверяем.
        setTimeout(load, 6000);
        setTimeout(load, 15000);
      }
    } catch {
      s.toast({ kind: "danger", title: "Не получилось", body: "Проверь соединение." });
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    await fetch("/api/bot/link", { method: "DELETE" }).catch(() => {});
    setLinked(false);
    s.toast({ kind: "info", title: "Бот отвязан", body: "Посты продолжат выходить, но писать я перестану." });
  };

  if (linked === null) return <div className="skeleton h-24 rounded-md" />;

  return linked ? (
    <div className="rounded-md bg-surface-inset p-4">
      <p className="flex items-center gap-2 text-[15px] font-semibold text-text">
        <span className="h-2 w-2 rounded-full bg-success-text" aria-hidden />
        Бот подключён
      </p>
      <p className="mt-1.5 text-[14px] leading-relaxed text-text-2">
        Пишет, когда пост вышел или упал, когда у конкурента залетело и когда готов план недели —
        с кнопками, чтобы не открывать сайт. Команды: /stats, /plan, /trends.
      </p>
      <Button size="sm" variant="ghost" onClick={disconnect} className="mt-3">
        Отвязать
      </Button>
    </div>
  ) : (
    <div className="rounded-md bg-surface-inset p-4">
      <p className="text-[15px] font-semibold text-text">Бот не подключён</p>
      <p className="mt-1.5 text-[14px] leading-relaxed text-text-2">
        {bot
          ? "Посты выходят по расписанию и без него, но о сбоях и залётах ты узнаешь только здесь, на сайте."
          : "Бот ещё не настроен на сервере — подключить пока нечего."}
      </p>
      {bot && (
        <Button size="sm" variant="brand" onClick={connect} loading={busy} className="mt-3">
          <Bot className="h-4 w-4" aria-hidden />
          Подключить бота
        </Button>
      )}
    </div>
  );
}

function BotSection({ index }: { index: number }) {
  const s = useStore();
  const { botLinked, weeklyReport } = s.settings;

  return (
    <Section
      icon={Bot}
      index={index}
      title="Telegram-бот"
      description="Короткая связь с платформой: бот пишет первым, когда есть о чём."
    >
      <BotLink />

      <Divider className="my-6" />

      <Toggle
        id="weekly-report"
        checked={weeklyReport}
        onChange={(v) => s.updateSettings({ weeklyReport: v })}
        label="Недельный отчёт"
        description="Каждое воскресенье: что вышло, что сработало и один совет на следующую неделю."
      />

      {weeklyReport && !botLinked && (
        <p className="mt-3 text-[13px] leading-relaxed text-text-3">
          Отчёт приходит в бот — пока он отвязан, отчёт не дойдёт.
        </p>
      )}
    </Section>
  );
}

/* ------------------------------------------------- 3. АВТОПИЛОТ (ТЗ 5.6) */

function AutopilotSection({ index }: { index: number }) {
  const s = useStore();
  const confirm = s.settings.autopilotConfirm;

  const change = (v: boolean) => {
    s.updateSettings({ autopilotConfirm: v });
    if (v) {
      s.toast({
        kind: "success",
        title: "Подтверждение вернули",
        body: "Теперь ничего не выйдет без твоего одобрения.",
      });
    } else {
      s.toast({
        kind: "info",
        title: "Полное доверие включено",
        body: "Платформа будет публиковать план сама. Выключить можно в любой момент.",
      });
    }
  };

  return (
    <Section
      icon={Rocket}
      index={index}
      title="Автопилот"
      description="Платформа собирает план на неделю. Ты решаешь, спрашивать ли разрешение перед публикацией."
    >
      <Toggle
        id="autopilot-confirm"
        checked={confirm}
        onChange={change}
        label="Спрашивать подтверждение плана"
        description="Пока включено — платформа не опубликует ничего, что ты не одобрил. Полное доверие можно включить после 2 недель одобрений без правок."
      />

      <AnimatePresence initial={false}>
        {!confirm && (
          <motion.div
            key="trust"
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.22, ease: EASE }}
            className="mt-5 flex items-start gap-3 rounded-sm bg-fire-soft p-4"
          >
            <TriangleAlert
              className="mt-0.5 h-5 w-5 shrink-0 text-fire"
              strokeWidth={2}
              aria-hidden
            />
            <p className="text-[14px] leading-relaxed text-fire-text">
              Полное доверие включено. Платформа будет публиковать план сама, без твоего
              подтверждения. Выключить можно в любой момент.
            </p>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2">
        <Link href="/app/autopilot" className="inline-block rounded-xs">
          <Button variant="outline" size="sm" tabIndex={-1}>
            Посмотреть план на неделю
          </Button>
        </Link>
        {/* База знаний наполняется сама (профиль из постов + ответы в боте), но посмотреть
            и поправить её руками можно здесь — прямая ссылка для продвинутых. */}
        <Link
          href="/app/knowledge"
          className="rounded-xs text-[13px] font-semibold text-text-3 underline-offset-4 transition-colors hover:text-text hover:underline"
        >
          Что ИИ знает о канале →
        </Link>
      </div>
    </Section>
  );
}

/* ------------------------------------------------------- 4. ТИХИЕ ЧАСЫ */

function QuietSection({ index }: { index: number }) {
  const s = useStore();
  const q = s.settings.quietHours;

  const setQuiet = (patch: Partial<SettingsData["quietHours"]>) =>
    s.updateSettings({ quietHours: { ...q, ...patch } });

  return (
    <Section
      icon={Moon}
      index={index}
      title="Тихие часы"
      description="Промежуток, в который платформа молчит — и в сетях, и в боте."
    >
      <Toggle
        id="quiet-hours"
        checked={q.enabled}
        onChange={(v) => setQuiet({ enabled: v })}
        label="Тихие часы"
        description="В это время платформа не публикует и не пишет в бот."
      />

      <AnimatePresence initial={false}>
        {q.enabled && (
          <motion.div
            key="range"
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.22, ease: EASE }}
            className="mt-6"
          >
            <div className="grid max-w-md grid-cols-2 gap-4">
              <Field label="С" htmlFor="quiet-from">
                <Input
                  id="quiet-from"
                  type="time"
                  className="nums"
                  value={q.from}
                  onChange={(e) => setQuiet({ from: e.target.value })}
                />
              </Field>
              <Field label="До" htmlFor="quiet-to">
                <Input
                  id="quiet-to"
                  type="time"
                  className="nums"
                  value={q.to}
                  onChange={(e) => setQuiet({ to: e.target.value })}
                />
              </Field>
            </div>

            <p className="mt-4 flex items-start gap-2 text-[13px] leading-relaxed text-text-3">
              <Clock className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={1.75} aria-hidden />
              <span>
                Тихо с <span className="nums font-semibold text-text-2">{q.from}</span> до{" "}
                <span className="nums font-semibold text-text-2">{q.to}</span>. Пост, попавший в
                этот промежуток, не потеряется — он выйдет в ближайшее разрешённое время.
              </span>
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </Section>
  );
}

/* ------------------------------------------------ 5. РЕЖИМ РАБОТЫ (ТЗ 5.10) */

const MODES: { value: SettingsData["mode"]; label: string; body: string; Icon: LucideIcon }[] = [
  { value: "solo", label: "Соло", body: "Ничего лишнего. Только ты и твои каналы.", Icon: User },
  {
    value: "team",
    label: "Команда",
    body: "Роли, согласования, комментарии. Для агентств и нескольких клиентов.",
    Icon: Users,
  },
];

function ModeSection({ index }: { index: number }) {
  const s = useStore();
  const saved = useSaved();
  const mode = s.settings.mode;

  const pick = (next: SettingsData["mode"]) => {
    if (next === mode) return;
    s.updateSettings({ mode: next });
    saved();
  };

  return (
    <Section
      icon={Users}
      index={index}
      title="Режим работы"
      description="По умолчанию — соло: интерфейс не показывает того, что тебе не нужно."
    >
      <div role="radiogroup" aria-label="Режим работы" className="grid gap-4 sm:grid-cols-2">
        {MODES.map(({ value, label, body, Icon }) => {
          const active = mode === value;
          return (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => pick(value)}
              className={cn(
                "relative flex cursor-pointer flex-col items-start gap-3 rounded-md border p-5 text-left",
                "transition-[transform,border-color,background-color,box-shadow] duration-200 ease-[var(--ease-soft)]",
                "active:scale-[0.99]",
                active
                  ? "border-brand bg-info-soft shadow-soft"
                  : "border-line bg-surface hover:border-line-strong hover:bg-surface-2",
              )}
            >
              {active && (
                <motion.span
                  layoutId="modeCheck"
                  aria-hidden
                  transition={{ type: "spring", stiffness: 420, damping: 34, mass: 0.7 }}
                  className="absolute top-4 right-4 grid h-6 w-6 place-items-center rounded-full bg-brand-gradient text-white"
                >
                  <Check className="h-3.5 w-3.5" strokeWidth={3} />
                </motion.span>
              )}

              <span
                aria-hidden
                className={cn(
                  "grid h-10 w-10 place-items-center rounded-sm transition-colors duration-200",
                  active ? "bg-surface text-brand" : "bg-surface-inset text-text-2",
                )}
              >
                <Icon className="h-5 w-5" strokeWidth={1.75} />
              </span>

              <span className="text-[15px] font-bold text-text">{label}</span>
              <span className="text-[14px] leading-relaxed text-text-2">{body}</span>
            </button>
          );
        })}
      </div>

      <AnimatePresence initial={false}>
        {mode === "team" && (
          <motion.div
            key="team"
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.22, ease: EASE }}
            className="mt-5 flex items-start gap-3 rounded-sm bg-info-soft p-4"
          >
            <Users className="mt-0.5 h-5 w-5 shrink-0 text-info-text" strokeWidth={1.75} aria-hidden />
            <p className="text-[14px] leading-relaxed text-info-text">
              Командные функции появятся в интерфейсе: колонка согласований в календаре и
              комментарии к постам.
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </Section>
  );
}

/* ------------------------------------------- 6. ИИ И ЛИМИТЫ (честность, ТЗ 6) */

function AiSection({ index }: { index: number }) {
  const s = useStore();
  const saved = useSaved();
  const reduce = useReducedMotion();

  const { aiUsedToday: used, aiDailyLimit: limit } = s.settings;
  const ratio = limit > 0 ? Math.min(1, used / limit) : 1;
  const hot = ratio >= 0.9;
  const left = Math.max(0, limit - used);

  // Поля правим локально, а в стор кладём по уходу из поля — иначе тост
  // «Сохранили» дёргался бы на каждой букве.
  // Секция монтируется уже после гидрации (каркас держит скелетон, пока !ready),
  // поэтому начальные значения сразу настоящие — до-синхронизация не нужна.
  const [niche, setNiche] = useState(s.settings.niche);
  const [tone, setTone] = useState(s.settings.tone);

  const commitNiche = () => {
    const v = niche.trim();
    setNiche(v);
    if (v === s.settings.niche) return;
    s.updateSettings({ niche: v });
    saved();
  };

  const commitTone = () => {
    const v = tone.trim();
    setTone(v);
    if (v === s.settings.tone) return;
    s.updateSettings({ tone: v });
    saved();
  };

  return (
    <Section
      icon={Sparkles}
      index={index}
      title="ИИ и лимиты"
      description="Сколько генераций осталось на сегодня и каким голосом ИИ пишет за тебя."
    >
      <div className="rounded-sm border border-line bg-surface-2 p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <p className="nums text-[15px] font-bold text-text">
            {fmtNum(used)} из {fmtNum(limit)}{" "}
            {plural(limit, "генерации", "генераций", "генераций")} сегодня
          </p>
          {hot ? (
            <Badge tone="fire">Почти всё</Badge>
          ) : (
            <p className="nums text-[13px] font-semibold text-text-2">Осталось {fmtNum(left)}</p>
          )}
        </div>

        <div
          role="progressbar"
          aria-label="Генерации ИИ за сегодня"
          aria-valuemin={0}
          aria-valuemax={limit}
          aria-valuenow={used}
          className="mt-3 h-2 w-full overflow-hidden rounded-full bg-surface-inset"
        >
          {/* Только transform: ширину не анимируем никогда (ТЗ 7.4) */}
          <motion.div
            className={cn(
              "h-full w-full origin-left rounded-full",
              hot ? "bg-fire" : "bg-brand-gradient",
            )}
            initial={{ scaleX: 0 }}
            animate={{ scaleX: ratio }}
            transition={reduce ? { duration: 0 } : { duration: 0.5, ease: EASE }}
          />
        </div>

        <p className="mt-4 text-[13px] leading-relaxed text-text-3">
          Лимит честный и виден всегда. ИИ стоит денег, поэтому мы не обещаем безлимит и не прячем
          ограничение в справке. Обновляется каждый день в полночь.
        </p>
      </div>

      <Divider className="my-6" />

      <div className="space-y-5">
        <Field
          label="Твоя ниша"
          htmlFor="niche"
          hint="По ней мы ищем залёты и подбираем, кого держать в конкурентах."
        >
          <Input
            id="niche"
            value={niche}
            onChange={(e) => setNiche(e.target.value)}
            onBlur={commitNiche}
            placeholder="Например: кофе, обжарка, домашнее заваривание"
          />
        </Field>

        <Field
          label="Тон текстов"
          htmlFor="tone"
          hint="Этим голосом ИИ пишет посты. Чем конкретнее опишешь — тем меньше придётся править."
        >
          <Textarea
            id="tone"
            rows={2}
            value={tone}
            onChange={(e) => setTone(e.target.value)}
            onBlur={commitTone}
            placeholder="Например: дружелюбный, на «ты», с личными историями и без пафоса"
          />
        </Field>
      </div>
    </Section>
  );
}

/* ------------------------------------------------------- 7. ОПАСНАЯ ЗОНА */

function DangerSection({ index }: { index: number }) {
  const s = useStore();
  const router = useRouter();
  const [asking, setAsking] = useState(false);

  // Сначала уходим с экрана, и только потом чистим стор.
  // Если обнулить пользователя, пока экран жив, защита каркаса увидит пустой вход
  // и уведёт на /register вместо лендинга. Поэтому мутация ждёт размонтирования.
  const onLeave = useRef<(() => void) | null>(null);
  useEffect(() => () => onLeave.current?.(), []);

  const resetDemo = () => {
    onLeave.current = s.reset;
    setAsking(false);
    s.toast({
      kind: "info",
      title: "Демо сброшено",
      body: "Посты, конкуренты и настройки вернулись в исходное состояние.",
    });
    router.push("/");
  };

  const leave = () => {
    onLeave.current = s.signOut;
    s.toast({
      kind: "info",
      title: "Вышли из аккаунта",
      body: "Демо осталось в этом браузере — вернёшься и продолжишь с того же места.",
    });
    router.push("/");
  };

  return (
    <Section
      icon={TriangleAlert}
      index={index}
      danger
      className="mt-12"
      title="Опасная зона"
      description="Два действия, которые нельзя отменить кнопкой «назад»."
    >
      <div className="space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
          <div className="min-w-0 max-w-md">
            <p className="text-[15px] font-semibold text-text">Сбросить демо-данные</p>
            <p className="mt-1 text-[13px] leading-relaxed text-text-2">
              Вернёт демо в исходное состояние. Все твои посты, конкуренты и настройки в этом
              браузере пропадут.
            </p>
          </div>
          <Button variant="danger" onClick={() => setAsking(true)} aria-expanded={asking}>
            <RotateCcw className="h-[18px] w-[18px]" strokeWidth={2} aria-hidden />
            Сбросить демо-данные
          </Button>
        </div>

        <AnimatePresence initial={false}>
          {asking && (
            <motion.div
              key="ask-reset"
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.22, ease: EASE }}
              className="rounded-sm border border-danger/30 bg-danger-soft p-4"
            >
              <p className="text-[15px] font-bold text-danger-text">
                Сбросить демо-данные? Это нельзя отменить.
              </p>
              <p className="mt-1 text-[14px] leading-relaxed text-danger-text/80">
                Посты, конкуренты и настройки в этом браузере пропадут, и мы вернём тебя на главную.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button variant="danger" onClick={resetDemo}>
                  <RotateCcw className="h-[18px] w-[18px]" strokeWidth={2} aria-hidden />
                  Да, сбросить
                </Button>
                <Button variant="ghost" onClick={() => setAsking(false)}>
                  Отмена
                </Button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <Divider />

        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
          <div className="min-w-0 max-w-md">
            <p className="text-[15px] font-semibold text-text">Выйти</p>
            <p className="mt-1 text-[13px] leading-relaxed text-text-2">
              Данные останутся на месте — войдёшь снова и продолжишь с того же места.
            </p>
          </div>
          <Button variant="outline" onClick={leave}>
            <LogOut className="h-[18px] w-[18px]" strokeWidth={1.75} aria-hidden />
            Выйти
          </Button>
        </div>
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------- СКЕЛЕТОН */
// Пока состояние поднимается из localStorage — форма экрана, а не пустота (ТЗ 7.4)

function SettingsSkeleton() {
  return (
    <div className="mx-auto max-w-3xl space-y-8" role="status" aria-busy="true">
      <span className="sr-only">Открываем настройки</span>
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="card-plain rounded-md p-6" aria-hidden>
          <div className="flex gap-3.5">
            <div className="skeleton h-10 w-10 rounded-sm" />
            <div className="flex-1 space-y-2">
              <div className="skeleton h-5 w-44" />
              <div className="skeleton h-4 w-3/4" />
            </div>
          </div>
          <div className="skeleton mt-7 h-12 w-full rounded-sm" />
          <div className="skeleton mt-3 h-12 w-full rounded-sm" />
        </div>
      ))}
    </div>
  );
}

/* ----------------------------------------------------------------- ЭКРАН */

export default function SettingsPage() {
  const s = useStore();

  return (
    <AppShell
      title="Настройки"
      subtitle="Всё важное — на одном экране. Ничего не спрятано в подменю."
    >
      {!s.ready ? (
        <SettingsSkeleton />
      ) : (
        <div className="mx-auto max-w-3xl space-y-8">
          <ChannelsSection index={0} />
          <BotSection index={1} />
          <AutopilotSection index={2} />
          <QuietSection index={3} />
          <ModeSection index={4} />
          <AiSection index={5} />
          <DangerSection index={6} />

          <p className="pt-2 pb-2 text-center text-[13px] text-text-3">
            Изменения сохраняются сразу — отдельной кнопки «Сохранить» здесь нет.
          </p>
        </div>
      )}
    </AppShell>
  );
}
