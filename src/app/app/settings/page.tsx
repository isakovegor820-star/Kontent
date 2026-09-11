"use client";

import { searchSettings, SETTINGS_SEARCH_ENTRIES, type SettingsSectionId } from "@/lib/settings-search";
/**
 * А12 — НАСТРОЙКИ (Приложение А).
 *
 * Всё, чем платформа распоряжается от твоего имени, собрано на одном экране:
 * поканальный профиль контента, сети (ТЗ 5.2), бот (5.9), автопилот (5.6),
 * тихие часы, режим соло/команда (5.10) и честный лимит ИИ.
 *
 * Поканальный профиль редактируется как черновик и применяется одной явной кнопкой.
 * Технические подключения остаются независимыми атомарными действиями, чтобы не
 * менять уже работающую механику интеграций и аккаунта.
 */

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { motion, useReducedMotion } from "motion/react";
import {
  Bell,
  Bot,
  BookOpen,
  Check,
  Clock,
  Download,
  ExternalLink,
  FolderKanban,
  Link2,
  Lock,
  Moon,
  Palette,
  Plug,
  Plus,
  Radio,
  Rocket,
  Search,
  Sparkles,
  TriangleAlert,
  UserRound,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { AppShell } from "@/components/app/shell";
import { AccountProfileSettings } from "@/components/app/account-profile-settings";
import { WritingSettingsSection } from "@/components/app/writing-settings-section";
import { ChannelSettingsCenter } from "@/components/app/channel-settings-center";
import { LegalSourcesSection } from "@/components/app/legal-sources-section";
import { NotificationSecuritySettings } from "@/components/app/notification-security-settings";
import { ProjectTeamSection } from "@/components/app/project-team-section";
import {
  ChannelCopySection,
  ProjectBasicsSection,
  SettingsPreviewPanel,
} from "@/components/app/settings-sections";
import { TrackingSettingsSection } from "@/components/app/tracking-settings-section";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Badge,
  Card,
  Divider,
  EmptyState,
  Input,
  InstagramIcon,
  LinkedInIcon,
  TelegramIcon,
  TikTokIcon,
  VkIcon,
  XIcon,
  YouTubeIcon,
} from "@/components/ui/primitives";
import { useStore } from "@/lib/store";
import { getAiUsageMetrics } from "@/lib/ai-usage-sync";
import type { Network } from "@/lib/types";
import { NETWORK_LABEL, cn, fmtNum, plural } from "@/lib/utils";
import {
  parseBotLinkStatusResponse,
  requestTelegramChannelConnection,
  requireBotUnlinkSuccess,
  telegramChannelConnectionSnapshot,
} from "@/lib/bot-link-client";
import { experimentalRoutesEnabled } from "@/lib/release-scope";
import {
  hasComposerPayloadSupport,
  type OAuthProviderCapability,
} from "@/lib/oauth-capabilities";
import type { TenChatIntegrationReadiness } from "@/lib/tenchat-integration.mjs";

const EASE = [0.22, 1, 0.36, 1] as const;
const EXPERIMENTAL_ROUTES_ENABLED = experimentalRoutesEnabled(
  process.env.NEXT_PUBLIC_AURORA_EXPERIMENTAL_ROUTES,
);

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
  const { refreshReal, toast } = s;
  const [disconnecting, setDisconnecting] = useState<number | null>(null);
  const [connectionPhase, setConnectionPhase] = useState<"idle" | "opening" | "waiting" | "connected" | "error">("idle");
  const [connectionMessage, setConnectionMessage] = useState("");
  const connectionBaseline = useRef("");
  const connectionDeadline = useRef(0);
  const connectionTimer = useRef<number | null>(null);
  const connectionChecking = useRef(false);
  const channels = s.realChannels.filter((channel) => (
    channel.status !== "disconnected"
    && (EXPERIMENTAL_ROUTES_ENABLED || channel.network === "tg")
  ));

  const stopConnectionPolling = useCallback(() => {
    if (connectionTimer.current != null) window.clearInterval(connectionTimer.current);
    connectionTimer.current = null;
    connectionChecking.current = false;
  }, []);

  const checkTelegramConnection = useCallback(async () => {
    if (connectionChecking.current) return;
    if (Date.now() >= connectionDeadline.current) {
      stopConnectionPolling();
      window.sessionStorage.removeItem("aurora:telegram-channel-connection");
      setConnectionPhase("error");
      setConnectionMessage("Telegram не подтвердил канал. Проверь, что выбрал именно канал и оставил право «Публикация сообщений», затем повтори.");
      return;
    }
    connectionChecking.current = true;
    try {
      const response = await fetch("/api/channels", { cache: "no-store" });
      const body = await response.json().catch(() => null) as { channels?: import("@/lib/types").RealChannel[] } | null;
      if (!response.ok || !Array.isArray(body?.channels)) return;
      const nextSnapshot = telegramChannelConnectionSnapshot(body.channels);
      const activeTelegram = body.channels.filter((channel) => channel.network === "tg" && channel.is_active);
      const baselineStates = new Set(connectionBaseline.current ? connectionBaseline.current.split("|") : []);
      const connected = activeTelegram.find((channel) => (
        !baselineStates.has(telegramChannelConnectionSnapshot([channel]))
      ));
      if (nextSnapshot === connectionBaseline.current || !connected) return;

      stopConnectionPolling();
      window.sessionStorage.removeItem("aurora:telegram-channel-connection");
      await refreshReal();
      const label = connected.title || (connected.handle ? `@${connected.handle}` : "Telegram-канал");
      setConnectionPhase("connected");
      setConnectionMessage(`Канал «${label}» подключён и готов к публикациям.`);
      toast({
        kind: "success",
        title: "Telegram-канал подключён",
        body: `Аврора проверила право публикации для «${label}».`,
      });
    } catch {
      // A short network interruption must not cancel an otherwise valid Telegram flow.
      // The next interval or window-focus event will retry until the deadline.
    } finally {
      connectionChecking.current = false;
    }
  }, [refreshReal, stopConnectionPolling, toast]);

  const startConnectionPolling = useCallback((baseline: string, deadline: number) => {
    stopConnectionPolling();
    connectionBaseline.current = baseline;
    connectionDeadline.current = deadline;
    setConnectionPhase("waiting");
    setConnectionMessage("Жду подтверждение Telegram. Выбери канал, оставь право публикации и вернись в Аврору — список обновится сам.");
    void checkTelegramConnection();
    connectionTimer.current = window.setInterval(() => void checkTelegramConnection(), 1_000);
  }, [checkTelegramConnection, stopConnectionPolling]);

  useEffect(() => {
    let resumeTimer: number | null = null;
    const pending = window.sessionStorage.getItem("aurora:telegram-channel-connection");
    if (pending) {
      try {
        const value = JSON.parse(pending) as { baseline?: unknown; deadline?: unknown };
        const deadline = Number(value.deadline);
        if (typeof value.baseline === "string" && Number.isFinite(deadline) && deadline > Date.now()) {
          resumeTimer = window.setTimeout(() => startConnectionPolling(value.baseline as string, deadline), 0);
        } else {
          window.sessionStorage.removeItem("aurora:telegram-channel-connection");
        }
      } catch {
        window.sessionStorage.removeItem("aurora:telegram-channel-connection");
      }
    }
    const checkWhenVisible = () => {
      if (document.visibilityState === "visible" && connectionTimer.current != null) {
        void checkTelegramConnection();
      }
    };
    window.addEventListener("focus", checkWhenVisible);
    document.addEventListener("visibilitychange", checkWhenVisible);
    return () => {
      if (resumeTimer != null) window.clearTimeout(resumeTimer);
      window.removeEventListener("focus", checkWhenVisible);
      document.removeEventListener("visibilitychange", checkWhenVisible);
      stopConnectionPolling();
    };
  }, [checkTelegramConnection, startConnectionPolling, stopConnectionPolling]);

  const connectTelegram = async () => {
    if (connectionPhase === "opening") return;
    stopConnectionPolling();
    window.sessionStorage.removeItem("aurora:telegram-channel-connection");
    setConnectionPhase("opening");
    setConnectionMessage("");
    // Open synchronously while this still is a trusted click. Async window.open calls are
    // commonly blocked on mobile Safari and leave the user thinking nothing happened.
    const telegramWindow = window.open("about:blank", "aurora-telegram-channel");
    try {
      const launch = await requestTelegramChannelConnection();
      const baseline = telegramChannelConnectionSnapshot(s.realChannels);
      const deadline = Date.now() + 90_000;
      window.sessionStorage.setItem(
        "aurora:telegram-channel-connection",
        JSON.stringify({ baseline, deadline }),
      );
      startConnectionPolling(baseline, deadline);
      if (telegramWindow && !telegramWindow.closed) {
        telegramWindow.opener = null;
        telegramWindow.location.replace(launch.url);
      } else {
        window.location.assign(launch.url);
      }
    } catch (reason) {
      telegramWindow?.close();
      const code = reason instanceof Error ? reason.message : "unknown";
      const message = code === "bot_conflict"
        ? "Бота сейчас слушает второй процесс. Аврора не открывает подключение, пока команды могут потеряться."
        : code === "bot_down"
          ? "Бот временно не принимает команды. Повтори через несколько секунд."
          : code === "bot_not_configured"
            ? "Telegram-бот не настроен на сервере."
            : "Не удалось открыть Telegram. Проверь соединение и повтори.";
      setConnectionPhase("error");
      setConnectionMessage(message);
    }
  };

  const addMore = () => void connectTelegram();
  const disconnect = async (channelId: number) => {
    if (disconnecting != null) return;
    if (!window.confirm("Отключить канал? История останется. Если есть запланированные публикации, Аврора сначала попросит отменить их.")) return;
    setDisconnecting(channelId);
    try {
      const response = await fetch(`/api/channels/${channelId}`, {
        method: "DELETE",
        headers: { "idempotency-key": crypto.randomUUID() },
      });
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      if (response.ok) {
        await s.refreshReal();
        s.toast({ kind: "success", title: "Канал отключён", body: "Токен деактивирован, история публикаций сохранена." });
      } else {
        s.toast({
          kind: "danger",
          title: "Канал пока не отключён",
          body: body?.error === "scheduled_publications_require_resolution"
            ? "Сначала отмени запланированные публикации этого канала в календаре."
            : body?.error === "publication_in_progress"
              ? "Публикация уже отправляется. Дождись подтверждённого результата."
              : "Не удалось подтвердить отключение. Попробуй ещё раз.",
        });
      }
    } finally {
      setDisconnecting(null);
    }
  };

  return (
    <Section
      icon={Link2}
      index={index}
      title={EXPERIMENTAL_ROUTES_ENABLED ? "Подключённые сети" : "Подключённые Telegram-каналы"}
      description={EXPERIMENTAL_ROUTES_ENABLED
        ? "Telegram и VK публикуют с сервера. Для остальных сетей здесь явно указан текущий статус поддержки."
        : "Telegram публикует с сервера, даже когда ваш компьютер выключен."}
    >
      <div className="mb-5 rounded-md border border-brand/20 bg-info-soft p-4">
        <p className="text-[15px] font-bold text-text">Подключение без перехода в мастер</p>
        <p className="mt-1.5 text-[13px] leading-relaxed text-text-2">
          Аврора откроет Telegram, попросит выбрать канал и проверит право публикации. Эта страница останется открытой и сама покажет результат.
        </p>
        <Button
          type="button"
          variant="brand"
          size="sm"
          loading={connectionPhase === "opening"}
          onClick={() => void connectTelegram()}
          className="mt-3"
        >
          <TelegramIcon className="h-4 w-4" aria-hidden />
          {channels.some((channel) => channel.network === "tg") ? "Подключить ещё канал" : "Выбрать канал в Telegram"}
        </Button>
        {connectionMessage ? (
          <p
            role={connectionPhase === "error" ? "alert" : "status"}
            aria-live="polite"
            className={cn(
              "mt-3 text-[13px] leading-relaxed font-medium",
              connectionPhase === "error"
                ? "text-danger-text"
                : connectionPhase === "connected"
                  ? "text-success-text"
                  : "text-text-2",
            )}
          >
            {connectionMessage}
          </p>
        ) : null}
      </div>
      {s.realError && (
        <div
          role="alert"
          className="mb-4 flex flex-wrap items-center gap-3 rounded-sm border border-danger/30 bg-danger-soft p-4 text-[14px] text-text"
        >
          <TriangleAlert className="h-5 w-5 shrink-0 text-danger-text" aria-hidden />
          <span className="min-w-0 flex-1">
            Не удалось обновить подключения. Сохранённые данные оставлены без изменений.
          </span>
          <Button variant="outline" size="sm" onClick={() => void s.refreshReal()}>
            Повторить
          </Button>
        </div>
      )}
      {!s.realReady ? (
        <p role="status" className="text-[14px] text-text-2">
          Проверяем подключения…
        </p>
      ) : s.realError && channels.length === 0 ? null : channels.length === 0 ? (
        <EmptyState
          icon={<Link2 className="h-6 w-6" strokeWidth={1.75} />}
          title="Ни одной сети"
          body={EXPERIMENTAL_ROUTES_ENABLED
            ? "Подключи Telegram или VK — без этого посты некуда отправлять."
            : "Подключи Telegram — без канала посты некуда отправлять."}
          action={
            <Button variant="outline" onClick={addMore}>
              <Plus className="h-[18px] w-[18px]" strokeWidth={2} aria-hidden />
              {EXPERIMENTAL_ROUTES_ENABLED ? "Подключить сеть" : "Подключить Telegram"}
            </Button>
          }
        />
      ) : (
        <ul className="space-y-3">
          {channels.map((ch) => {
            const Glyph = ch.network === "tg" ? TelegramIcon : ch.network === "vk" ? VkIcon : Link2;
            const label = ch.title ?? ch.handle ?? `Канал #${ch.id}`;
            const publishSupported = hasComposerPayloadSupport(ch.network);
            return (
              <li key={ch.id} className="rounded-sm border border-line bg-surface-2 p-4">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
                  <span
                    aria-hidden
                    className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-info-soft text-brand"
                  >
                    <Glyph className="h-5 w-5" />
                  </span>

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <p className="truncate text-[15px] font-bold text-text">{label}</p>
                      <Badge tone="neutral">{NETWORK_LABEL[ch.network]}</Badge>
                    </div>
                    {ch.handle && ch.handle !== ch.title && (
                      <p className="mt-1 truncate font-mono text-[13px] text-text-3">{ch.handle}</p>
                    )}
                  </div>

                  {publishSupported && ch.is_active ? (
                    <Badge tone="success">
                      <Check className="h-3.5 w-3.5" strokeWidth={3} aria-hidden />
                      Активен
                    </Badge>
                  ) : ch.reconnect_required ? (
                    <Badge tone="fire">Нужно переподключить</Badge>
                  ) : (
                    <Badge tone="neutral">Публикация недоступна</Badge>
                  )}
                </div>
                {ch.reconnect_required && (
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                    <p role="status" className="text-[13px] leading-relaxed text-danger-text">
                      Аврора остановила новые публикации после ошибки доступа. История сохранена.
                    </p>
                    <Button type="button" variant="outline" size="sm" onClick={addMore}>
                      Переподключить
                    </Button>
                  </div>
                )}
                {!publishSupported && !ch.reconnect_required && (
                  <p className="mt-2 text-[13px] leading-relaxed text-text-3">
                    Подключение сохранено, но выбрать эту сеть в Композиторе пока нельзя.
                  </p>
                )}
                <div className="mt-3 flex justify-end">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    loading={disconnecting === ch.id}
                    disabled={disconnecting != null && disconnecting !== ch.id}
                    onClick={() => void disconnect(ch.id)}
                  >
                    Отключить
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {channels.length > 0 && (
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <Button variant="outline" onClick={addMore}>
            <Plus className="h-[18px] w-[18px]" strokeWidth={2} aria-hidden />
            {EXPERIMENTAL_ROUTES_ENABLED ? "Подключить ещё" : "Подключить ещё Telegram"}
          </Button>
        </div>
      )}

      {EXPERIMENTAL_ROUTES_ENABLED && (
        <>
          <Divider className="my-6" />

          {/* Настоящее подключение VK-сообщества (аналог TG bot-link): ключ доступа сообщества. */}
          <VkConnect />

          {/* TenChat остаётся частью общей системы каналов, но не притворяется live-интеграцией. */}
          <TenChatIntegration />

          {/* Зарубежные сети (YouTube, Instagram, ...) — подключение в один клик через OAuth. */}
          <OAuthNetworks />
        </>
      )}

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
        <Button type="submit" variant="outline" data-aurora-feature="configuration" data-aurora-action="connected" loading={busy} className="shrink-0">
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

/* ---------------------------------------- 1в. TENCHAT: OFFICIAL-ACCESS BOUNDARY */

function TenChatIntegration() {
  const [readiness, setReadiness] = useState<TenChatIntegrationReadiness | null>(null);
  const [statusError, setStatusError] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/channels/tenchat", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const body = await response.json().catch(() => null) as {
          provider?: TenChatIntegrationReadiness;
        } | null;
        if (!response.ok || !body?.provider) throw new Error("tenchat_readiness_unavailable");
        setReadiness(body.provider);
        setStatusError(false);
      })
      .catch(() => {
        if (!controller.signal.aborted) setStatusError(true);
      });
    return () => controller.abort();
  }, []);

  return (
    <section
      aria-labelledby="tenchat-integration-title"
      className="mt-4 rounded-md border border-fire/25 bg-fire-soft/55 p-4"
    >
      <div className="flex flex-wrap items-start gap-3">
        <span
          aria-hidden
          className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-surface text-fire-text"
        >
          <Link2 className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 id="tenchat-integration-title" className="text-[15px] font-semibold text-text">
              TenChat
            </h3>
            <Badge tone="fire">Нужен официальный доступ</Badge>
          </div>
          <p className="mt-1.5 text-[14px] leading-relaxed text-text-2">
            Автопубликация выключена: на 12 августа 2026 года в официальных материалах
            TenChat не найден документированный API для публикации. Аврора не использует
            скрытые API, пароли или имитацию действий в браузере.
          </p>
        </div>
      </div>

      <dl className="mt-4 grid gap-2 text-[13px] sm:grid-cols-2">
        <div className="rounded-sm border border-line bg-surface px-3 py-2.5">
          <dt className="text-text-3">Автопубликация</dt>
          <dd className="mt-0.5 font-semibold text-text">Недоступна без официального доступа</dd>
        </div>
        <div className="rounded-sm border border-line bg-surface px-3 py-2.5">
          <dt className="text-text-3">Безопасная альтернатива</dt>
          <dd className="mt-0.5 font-semibold text-text">ZIP-пакет владельцу или публикатору</dd>
        </div>
      </dl>

      <p className="mt-3 text-[12px] leading-relaxed text-text-3" aria-live="polite">
        {statusError
          ? "Статус сервера не обновился. Автопубликация всё равно остаётся выключенной."
          : readiness
            ? `Проверено по официальным источникам: ${readiness.officialAccess.checkedAt.split("-").reverse().join(".")}. Автопубликация не подтверждена.`
            : "Проверяем серверную готовность…"}
      </p>

      <div className="mt-4 flex flex-wrap gap-2">
        <Link
          href="/app/composer?export=tenchat#tenchat-export"
          className="inline-flex min-h-11 items-center justify-center gap-2 rounded-[10px] border border-line-strong bg-surface px-3.5 py-2 text-[13px] font-semibold text-text transition-colors hover:bg-surface-inset"
        >
          <Download className="h-4 w-4" aria-hidden />
          Подготовить пакет
        </Link>
        <a
          href="https://tenchat.ru/contacts"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex min-h-11 items-center justify-center gap-2 rounded-[10px] px-3.5 py-2 text-[13px] font-semibold text-text-2 transition-colors hover:bg-surface hover:text-text"
        >
          Запросить доступ у TenChat
          <ExternalLink className="h-4 w-4" aria-hidden />
        </a>
      </div>
      <a
        href="https://cdn1.tenchat.ru/static/vbc-gostinder/document/921e5418-d917-4e97-bb89-e296418e2a30.pdf"
        target="_blank"
        rel="noopener noreferrer"
        className="mt-2 inline-flex min-h-11 items-center gap-1.5 rounded-sm px-2 text-[12px] font-semibold text-text-3 underline decoration-line-strong underline-offset-4 hover:text-text"
      >
        Официальные правила TenChat
        <ExternalLink className="h-3.5 w-3.5" aria-hidden />
      </a>
    </section>
  );
}

/* -------------------------------------------- 1г. ЗАРУБЕЖНЫЕ СЕТИ (OAuth) */

/** Человекочитаемая причина сбоя подключения (пришли из колбэка в ?oauth=...). */
function oauthMessage(code: string, label: string): string {
  switch (code) {
    case "denied":
      return `Ты отменил вход на экране согласия ${label}. Попробуй ещё раз.`;
    case "not_configured":
      return `${label} пока не настроен на сервере. Напиши в поддержку.`;
    case "no_account":
      return `Не нашли подходящий аккаунт ${label}. Проверь, что входишь в нужный аккаунт.`;
    case "taken":
      return `Этот канал ${label} уже подключён к другому аккаунту Авроры.`;
    case "expired":
    case "state_mismatch":
      return "Сессия подключения истекла. Нажми «Подключить» ещё раз.";
    case "unauthorized":
      return "Сессия истекла — зайди заново.";
    case "unsupported":
      return `Подключение ${label} закрыто, пока Композитор не умеет создавать и публиковать подходящий контент.`;
    default:
      return "Что-то пошло не так. Попробуй ещё раз.";
  }
}


/**
 * Карта будущих OAuth-сетей. Кнопка входа появляется только после серверного подтверждения,
 * что Композитор умеет собрать полноценный payload публикации; одних credentials недостаточно.
 * Сети со статусом `soon` остаются явно неоперационными roadmap-карточками.
 */

const OAUTH_NETWORKS: {
  id: Network;
  label: string;
  hint: string;
  status: "oauth" | "soon";
  Glyph: (p: { className?: string }) => React.JSX.Element;
}[] = [
  {
    id: "youtube",
    label: "YouTube",
    hint: "Публикация из Композитора пока недоступна",
    status: "oauth",
    Glyph: YouTubeIcon,
  },
  {
    id: "instagram",
    label: "Instagram",
    hint: "Публикация из Композитора пока недоступна",
    status: "oauth",
    Glyph: InstagramIcon,
  },
  { id: "x", label: "X (Twitter)", hint: "Скоро", status: "soon", Glyph: XIcon },
  { id: "tiktok", label: "TikTok", hint: "Скоро", status: "soon", Glyph: TikTokIcon },
  { id: "linkedin", label: "LinkedIn", hint: "Скоро", status: "soon", Glyph: LinkedInIcon },
];

function OAuthNetworks() {
  const s = useStore();
  const [capabilities, setCapabilities] = useState<
    Partial<Record<Network, OAuthProviderCapability>> | null
  >(null);
  const [providerError, setProviderError] = useState(false);
  // Уже подключённые OAuth-сети берём из реальных каналов (не из демо-стора).
  const connected = new Set(
    s.realChannels.filter((c) => c.is_active).map((c) => c.network),
  );

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/channels/oauth/providers", { cache: "no-store", signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error("providers_unavailable");
        return response.json();
      })
      .then((body: { providers?: Partial<Record<Network, OAuthProviderCapability>> } | null) => {
        if (!body?.providers) throw new Error("providers_invalid");
        setCapabilities(body.providers);
      })
      .catch(() => {
        if (!controller.signal.aborted) setProviderError(true);
      });
    return () => controller.abort();
  }, []);

  return (
    <div className="mt-4 rounded-md bg-surface-inset p-4">
      <p className="text-[15px] font-semibold text-text">Зарубежные сети</p>
      <p className="mt-1.5 text-[14px] leading-relaxed text-text-2">
        Подключение откроется только вместе с полноценной публикацией из Композитора. Сейчас
        YouTube и Instagram показаны как будущие возможности — вход в них закрыт.
      </p>
      {providerError && (
        <p role="alert" className="mt-2 text-[13px] text-danger-text">
          Не удалось проверить доступность подключений. Обнови страницу и попробуй ещё раз.
        </p>
      )}
      <ul className="mt-3 grid gap-2 sm:grid-cols-2">
        {OAUTH_NETWORKS.map(({ id, label, hint, status, Glyph }) => {
          const isConnected = connected.has(id);
          const capability = capabilities?.[id];
          const unsupported = capability?.status === "unsupported";
          const providerHint =
            isConnected && unsupported
              ? `Аккаунт подключён ранее, но публикация в ${label} пока недоступна в Композиторе.`
              : capability?.message ?? hint;
          return (
            <li
              key={id}
              className="flex items-center gap-3 rounded-sm border border-line bg-surface px-3 py-2.5"
            >
              <span
                aria-hidden
                className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-surface-inset text-brand"
              >
                <Glyph className="h-[18px] w-[18px]" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[14px] font-semibold text-text">{label}</p>
                <p className="text-[12px] leading-snug text-text-3">{providerHint}</p>
              </div>
              {status === "soon" ? (
                <Badge tone="neutral">Скоро</Badge>
              ) : providerError ? (
                <Badge tone="neutral">Недоступно</Badge>
              ) : capabilities === null ? (
                <Badge tone="neutral">Проверяем…</Badge>
              ) : unsupported ? (
                <Badge tone="neutral">Нет публикации</Badge>
              ) : capability?.status === "not_configured" ? (
                <Badge tone="neutral">Не настроено</Badge>
              ) : isConnected && capability?.available ? (
                <Badge tone="success">
                  <Check className="h-3.5 w-3.5" strokeWidth={3} aria-hidden />
                  Подключено
                </Badge>
              ) : !capability?.available ? (
                <Badge tone="neutral">Недоступно</Badge>
              ) : (
                // Полная навигация (не SPA): уходим на экран согласия провайдера и обратно.
                <a
                  href={`/api/channels/oauth/start?network=${id}`}
                  className={cn(
                    "inline-flex shrink-0 items-center rounded-sm border border-line-strong",
                    "px-3 py-1.5 text-[13px] font-semibold text-text transition-colors hover:bg-surface-2",
                  )}
                >
                  Подключить
                </a>
              )}
            </li>
          );
        })}
      </ul>
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
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [linked, setLinked] = useState(false);
  const [bot, setBot] = useState<string | null>(null);
  const [botStatus, setBotStatus] = useState<"up" | "down" | "not_configured" | "conflict">("not_configured");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const pollTimers = useRef<number[]>([]);
  const requestSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    try {
      const response = await fetch("/api/bot/link", { cache: "no-store" });
      const status = await parseBotLinkStatusResponse(response);
      if (seq !== requestSeq.current) return;
      setLinked(status.linked);
      setBot(status.bot);
      setBotStatus(status.botStatus);
      setActionError(null);
      setPhase("ready");
    } catch {
      if (seq !== requestSeq.current) return;
      setPhase("error");
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load updates state only after the request settles
    void load();
    return () => {
      requestSeq.current += 1;
      for (const timer of pollTimers.current) window.clearTimeout(timer);
    };
  }, [load]);

  const retryLoad = () => {
    setPhase("loading");
    setActionError(null);
    void load();
  };

  const connect = async () => {
    if (busy || botStatus !== "up") return;
    requestSeq.current += 1;
    setActionError(null);
    setBusy(true);
    try {
      const r = await fetch("/api/bot/link", { method: "POST" });
      const d = (await r.json().catch(() => null)) as {
        ok?: boolean;
        url?: string;
        error?: string;
        needs?: string;
      } | null;
      if (d?.error === "bot_not_configured") {
        const message = `Нужно имя бота в ${d.needs ?? "TG_BOT_USERNAME"} — без него ссылку не собрать.`;
        setBot(null);
        setActionError(message);
        s.toast({
          kind: "info",
          title: "Бот ещё не настроен",
          body: message,
        });
        return;
      }
      if (!r.ok || !d?.ok || !d.url) {
        throw new Error(d?.error || "bot_link_failed");
      }

      window.open(d.url, "_blank", "noopener");
      s.toast({
        kind: "info",
        title: "Открыл Telegram",
        body: "Нажми «Начать» в чате с ботом — и вернись сюда, я подхвачу.",
      });
      // Ссылка одноразовая: человек жмёт /start в Telegram, а мы ждём и проверяем.
      for (const timer of pollTimers.current) window.clearTimeout(timer);
      pollTimers.current = [
        window.setTimeout(() => void load(), 6000),
        window.setTimeout(() => void load(), 15000),
      ];
    } catch {
      setActionError("Не удалось создать ссылку на бота. Статус подключения не изменён.");
      s.toast({ kind: "danger", title: "Не получилось", body: "Проверь соединение." });
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    if (busy) return;
    requestSeq.current += 1;
    for (const timer of pollTimers.current) window.clearTimeout(timer);
    pollTimers.current = [];
    setActionError(null);
    setBusy(true);
    try {
      const response = await fetch("/api/bot/link", { method: "DELETE" });
      await requireBotUnlinkSuccess(response);
      setLinked(false);
      s.toast({
        kind: "info",
        title: "Бот отвязан",
        body: "Посты продолжат выходить, но писать я перестану.",
      });
    } catch {
      const message = "Не удалось подтвердить отвязку. Статус подключения нужно проверить заново.";
      setPhase("error");
      s.toast({ kind: "danger", title: "Статус бота неизвестен", body: message });
    } finally {
      setBusy(false);
    }
  };

  if (phase === "loading") return <div className="skeleton h-24 rounded-md" />;

  if (phase === "error") {
    return (
      <div
        role="alert"
        className="rounded-md border border-danger/30 bg-danger-soft p-4 text-[14px] text-text"
      >
        <p className="flex items-center gap-2 font-semibold text-danger-text">
          <TriangleAlert className="h-5 w-5 shrink-0" aria-hidden />
          Не удалось проверить связь с ботом
        </p>
        <p className="mt-1.5 leading-relaxed text-text-2">
          Не показываем статус подключения, пока сервер не подтвердит его.
        </p>
        <Button size="sm" variant="outline" onClick={retryLoad} className="mt-3">
          Повторить
        </Button>
      </div>
    );
  }

  const botAvailable = botStatus === "up";

  return linked ? (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "rounded-md border p-4",
        botAvailable ? "border-success/20 bg-success-soft" : "border-danger/20 bg-danger-soft",
      )}
    >
      <p className={cn(
        "flex items-center gap-2 text-[15px] font-semibold",
        botAvailable ? "text-success-text" : "text-danger-text",
      )}>
        {botAvailable
          ? <Check className="h-5 w-5 shrink-0" aria-hidden />
          : <TriangleAlert className="h-5 w-5 shrink-0" aria-hidden />}
        {botAvailable
          ? "Бот на связи"
          : botStatus === "conflict"
            ? "Бота слушает второй процесс"
            : "Чат привязан, бот не отвечает"}
      </p>
      <p className="mt-1.5 text-[14px] leading-relaxed text-text-2">
        {botAvailable
          ? "Принимает команды и кнопки, сообщает о публикациях и результатах. Команды: /stats, /calendar, /approvals."
          : botStatus === "not_configured"
            ? "Связь с аккаунтом сохранена, но Telegram-бот не настроен на сервере. Переподключать чат не нужно."
            : botStatus === "conflict"
              ? "Связь с аккаунтом сохранена. Останови второй воркер или замени токен бота — переподключать чат не нужно."
            : "Связь с аккаунтом сохранена. Переподключать чат не нужно — приём сообщений временно остановлен."}
      </p>
      {actionError && (
        <p role="alert" className="mt-3 text-[13px] leading-relaxed font-medium text-danger-text">
          {actionError}
        </p>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {!botAvailable ? (
          <Button size="sm" variant="outline" onClick={retryLoad} loading={busy}>
            Проверить снова
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" onClick={disconnect} loading={busy}>
          Отвязать чат
        </Button>
      </div>
    </div>
  ) : (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "rounded-md border p-4",
        botStatus === "conflict"
          ? "border-danger/20 bg-danger-soft"
          : "border-transparent bg-surface-inset",
      )}
    >
      <p className={cn(
        "flex items-center gap-2 text-[15px] font-semibold",
        botStatus === "conflict" ? "text-danger-text" : "text-text",
      )}>
        {botStatus === "conflict" ? (
          <TriangleAlert className="h-5 w-5 shrink-0" aria-hidden />
        ) : null}
        {botStatus === "conflict" ? "Найден второй воркер" : "Бот не подключён"}
      </p>
      <p className="mt-1.5 text-[14px] leading-relaxed text-text-2">
        {botAvailable
          ? "Посты выходят по расписанию и без него, но о сбоях и залётах ты узнаешь только здесь, на сайте."
          : botStatus === "conflict"
            ? "Этого бота одновременно слушает другой процесс. Подключение откроется после остановки второго воркера или замены токена."
          : bot
            ? "Бот настроен, но сейчас не принимает сообщения. Подключение станет доступно после восстановления связи."
            : "Бот ещё не настроен на сервере — подключить пока нечего."}
      </p>
      {actionError && (
        <p role="alert" className="mt-3 text-[13px] leading-relaxed font-medium text-danger-text">
          {actionError}
        </p>
      )}
      {botAvailable && bot ? (
        <Button size="sm" variant="brand" onClick={connect} loading={busy} className="mt-3">
          <Bot className="h-4 w-4" aria-hidden />
          Подключить бота
        </Button>
      ) : bot ? (
        <Button size="sm" variant="outline" onClick={retryLoad} loading={busy} className="mt-3">
          Проверить снова
        </Button>
      ) : null}
    </div>
  );
}

function BotSection({ index }: { index: number }) {
  return (
    <Section
      icon={Bot}
      index={index}
      title="Telegram-бот"
      description="Короткая связь с платформой: бот пишет первым, когда есть о чём."
    >
      <BotLink />
    </Section>
  );
}

/* ------------------------------------------------------- 4. ТИХИЕ ЧАСЫ */

function QuietSection({ index }: { index: number }) {
  return (
    <Section
      icon={Moon}
      index={index}
      title="Тихие часы"
      description="Пауза в ночных публикациях пока недоступна."
    >
      <div className="flex items-start gap-3 rounded-sm bg-surface-inset p-4" role="status">
        <Clock className="mt-0.5 h-5 w-5 shrink-0 text-text-3" strokeWidth={1.75} aria-hidden />
        <p className="text-[14px] leading-relaxed text-text-2">
          Сейчас каждый пост выходит строго в выбранное в календаре время. Пока выбирай дневное время для публикаций в календаре.
        </p>
      </div>
    </Section>
  );
}

/* ------------------------------------------- 6. ИИ И ЛИМИТЫ (честность, ТЗ 6) */

function AiSection({ index }: { index: number }) {
  const s = useStore();
  const reduce = useReducedMotion();

  const usage = getAiUsageMetrics(s.aiUsageStatus, s.aiUsed, s.aiLimit);

  return (
    <Section
      icon={Sparkles}
      index={index}
      title="ИИ и лимиты"
      description="Сколько генераций осталось на сегодня и каким голосом ИИ пишет за тебя."
    >
      <div className="rounded-sm border border-line bg-surface-2 p-5">
        {usage ? (
          <>
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <p className="nums text-[15px] font-bold text-text">
                {fmtNum(usage.used)} из {fmtNum(usage.limit)}{" "}
                {plural(usage.limit, "генерации", "генераций", "генераций")} сегодня
              </p>
              {usage.hot ? (
                <Badge tone="fire">Почти всё</Badge>
              ) : (
                <p className="nums text-[13px] font-semibold text-text-2">
                  Осталось {fmtNum(usage.left)}
                </p>
              )}
            </div>

            <div
              role="progressbar"
              aria-label="Генерации ИИ за сегодня"
              aria-valuemin={0}
              aria-valuemax={usage.limit}
              aria-valuenow={usage.used}
              className="mt-3 h-2 w-full overflow-hidden rounded-full bg-surface-inset"
            >
              {/* Только transform: ширину не анимируем никогда (ТЗ 7.4) */}
              <motion.div
                className={cn(
                  "h-full w-full origin-left rounded-full",
                  usage.hot ? "bg-fire" : "bg-brand-gradient",
                )}
                initial={{ scaleX: 0 }}
                animate={{ scaleX: usage.ratio }}
                transition={reduce ? { duration: 0 } : { duration: 0.5, ease: EASE }}
              />
            </div>

            <p className="mt-4 text-[13px] leading-relaxed text-text-3">
              Лимит подтверждает сервер. ИИ стоит денег, поэтому мы не обещаем безлимит и не
              прячем ограничение в справке. Счётчик обновляется каждый день в полночь.
            </p>
          </>
        ) : (
          <div role="status" aria-live="polite">
            <p className="text-[15px] font-bold text-text">
              {s.aiUsageStatus === "loading"
                ? "Проверяем лимит генераций…"
                : "Счётчик генераций временно недоступен"}
            </p>
            <p className="mt-2 text-[13px] leading-relaxed text-text-3">
              {s.aiUsageStatus === "loading"
                ? "Покажем остаток, когда сервер подтвердит данные."
                : "Не показываем прогресс и остаток как факт, пока связь со счётчиком не восстановится."}
            </p>
          </div>
        )}
      </div>

      <div className="mt-5 flex flex-wrap gap-2">
        <Link
          href="/app/knowledge"
          className="inline-flex min-h-10 items-center rounded-xs border border-line px-3.5 text-[13px] font-semibold text-text-2 transition-colors hover:border-line-strong hover:text-text"
        >
          Проверить профиль и источники голоса
        </Link>
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------- СКЕЛЕТОН */
// Пока состояние поднимается из localStorage — форма экрана, а не пустота (ТЗ 7.4)

function SettingsSkeleton() {
  return (
    <div className="grid items-start gap-5 lg:grid-cols-[15.5rem_minmax(0,1fr)] lg:items-stretch" role="status" aria-busy="true">
      <span className="sr-only">Открываем настройки</span>
      <div className="card-plain space-y-2 rounded-md p-3" aria-hidden>
        <div className="skeleton h-11 rounded-sm" />
        {[0, 1, 2, 3, 4, 5].map((item) => <div key={item} className="skeleton h-14 rounded-sm" />)}
      </div>
      <div className="card-plain rounded-md p-6" aria-hidden>
        <div className="flex gap-3.5"><div className="skeleton h-10 w-10 rounded-sm" /><div className="flex-1 space-y-2"><div className="skeleton h-5 w-44" /><div className="skeleton h-4 w-3/4" /></div></div>
        <div className="skeleton mt-7 h-12 w-full rounded-sm" />
        <div className="skeleton mt-3 h-28 w-full rounded-sm" />
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- ЭКРАН */

const SETTINGS_SECTIONS: Array<{
  id: SettingsSectionId;
  label: string;
  description: string;
  icon: LucideIcon;
}> = [
  { id: "profile", label: "Профиль", description: "Аккаунт · личные предпочтения", icon: UserRound },
  { id: "project", label: "Проект", description: "Команда, время и лимиты", icon: FolderKanban },
  { id: "channels", label: "Каналы", description: "Подключения и копирование", icon: Radio },
  { id: "content", label: "Контент и стиль", description: "Голос, структура и тест поста", icon: Palette },
  { id: "autopilot", label: "Автопилот", description: "Планирование с подтверждением", icon: Rocket },
  { id: "dictionary", label: "Правила текста", description: "Названия, запреты и шаблоны", icon: BookOpen },
  { id: "integrations", label: "Интеграции", description: "Проект · UTM, сайт и бот", icon: Plug },
  { id: "notifications", label: "Уведомления и безопасность", description: "Email, Telegram, пароль и выход", icon: Bell },
];

const SETTINGS_SECTION_IDS = new Set<SettingsSectionId>(SETTINGS_SECTIONS.map((item) => item.id));

function normalizeSection(value: string | null): SettingsSectionId {
  if (value === "posts") return "content";
  if (value === "general") return "profile";
  return SETTINGS_SECTION_IDS.has(value as SettingsSectionId) ? value as SettingsSectionId : "profile";
}

function SettingsContent() {
  const s = useStore();
  // Стабильные ссылки из стора: toast/refreshReal — useCallback([]), ready — примитив.
  // В зависимость эффекта берём ИХ, а не весь объект s: идентичность s меняется на
  // каждый тост (стор мемоизирован с toasts), и эффект с s в deps уходил в бесконечный
  // цикл «тост → новый s → эффект → тост» (Maximum update depth exceeded).
  const { ready, toast, refreshReal } = s;
  const router = useRouter();
  const searchParams = useSearchParams();
  const activeSection = normalizeSection(searchParams.get("section"));
  const [query, setQuery] = useState("");
  const panelRef = useRef<HTMLElement>(null);
  const [focusRequest, setFocusRequest] = useState(0);
  const [navigationMessage, setNavigationMessage] = useState("");
  const [pendingNavigation, setPendingNavigation] = useState<{ section: SettingsSectionId; setting?: string } | null>(null);
  const targetId = searchParams.get("setting");

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel || !ready) return;
    const entry = SETTINGS_SEARCH_ENTRIES.find((item) => item.id === targetId && item.section === activeSection);
    if (!entry) { panel.scrollTop = 0; return; }
    let highlighted: HTMLElement | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reveal = () => {
      const target = panel.querySelector<HTMLElement>(entry.target);
      if (!target) return false;
      for (let parent = target.parentElement; parent && parent !== panel; parent = parent.parentElement) {
        if (parent instanceof HTMLDetailsElement) parent.open = true;
      }
      if (!target.matches("input, select, textarea, button, a[href]")) target.tabIndex = -1;
      target.focus({ preventScroll: true });
      target.scrollIntoView({ block: "center", behavior: "instant" });
      highlighted = target.closest<HTMLElement>("label") ?? target;
      highlighted.dataset.settingsHighlight = "true";
      timer = setTimeout(() => { if (highlighted) delete highlighted.dataset.settingsHighlight; }, 3500);
      return true;
    };
    const observer = new MutationObserver(() => { if (reveal()) { observer.disconnect(); setNavigationMessage(""); } });
    if (!reveal()) observer.observe(panel, { childList: true, subtree: true });
    const deadline = setTimeout(() => {
      if (!highlighted) setNavigationMessage("Раздел открыт. Настройка станет доступна после загрузки данных или подключения канала.");
    }, 8000);
    return () => { observer.disconnect(); clearTimeout(deadline); clearTimeout(timer); if (highlighted) delete highlighted.dataset.settingsHighlight; };
  }, [activeSection, targetId, focusRequest, ready]);

  const navigateToSection = (section: SettingsSectionId, setting?: string) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("section", section);
    if (setting) params.set("setting", setting); else params.delete("setting");
    setFocusRequest((value) => value + 1);
    setNavigationMessage("");
    params.delete("connected");
    params.delete("oauth");
    params.delete("network");
    router.replace(`/app/settings?${params.toString()}`, { scroll: false });
  };

  const selectSection = (section: SettingsSectionId, setting?: string) => {
    if (section === activeSection && !setting) return;
    if (section !== activeSection && document.querySelector('[data-settings-dirty="true"]')) {
      setPendingNavigation({ section, setting });
      return;
    }
    navigateToSection(section, setting);
  };

  const results = searchSettings(query);
  const searching = Boolean(query.trim());

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (document.querySelector('[data-settings-dirty="true"]')) event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);

  // Возврат из OAuth-редиректа: показываем итог подключения и чистим URL.
  useEffect(() => {
    if (!ready) return;
    const connected = searchParams.get("connected");
    const oauthErr = searchParams.get("oauth");
    if (!connected && !oauthErr) return;

    if (connected) {
      refreshReal();
      const publishSupported = hasComposerPayloadSupport(connected);
      toast({
        kind: publishSupported ? "success" : "info",
        title: `${NETWORK_LABEL[connected ?? ""] ?? connected} подключён`,
        body: publishSupported
          ? "Канал в списке — теперь сюда можно публиковать."
          : "Подключение сохранено, но публикация в эту сеть пока недоступна в Композиторе.",
      });
    } else {
      const network = searchParams.get("network") || "";
      const label = NETWORK_LABEL[network] ?? network;
      const msg = oauthMessage(oauthErr ?? "", label);
      const unsupported = oauthErr === "unsupported";
      toast({
        kind: unsupported ? "info" : "danger",
        title: unsupported ? "Подключение пока недоступно" : "Не получилось подключить",
        body: msg,
      });
    }
    // URL без параметров, чтобы тост не всплыл повторно при обновлении страницы.
    // После очистки searchParams эффект перезапустится и молча выйдет (нет параметров).
    router.replace("/app/settings?section=integrations", { scroll: false });
  }, [searchParams, ready, toast, refreshReal, router]);

  return (
    <AppShell
      title="Настройки"
      subtitle="Личные предпочтения, параметры проекта и каналов."
      workspace
    >
      {!s.ready ? (
        <SettingsSkeleton />
      ) : (
        <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-4 lg:grid-cols-[15.5rem_minmax(0,1fr)] lg:grid-rows-1" data-settings-workspace>
          <aside className="flex min-h-0 flex-col rounded-md border border-line bg-surface p-3 shadow-soft" aria-label="Навигация настроек">
            <label className="block shrink-0">
              <span className="mb-2 block text-[13px] font-semibold text-text">Найти настройку</span>
              <span className="relative block">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-3" aria-hidden />
              <Input value={query} onChange={(event) => setQuery(event.currentTarget.value)} className="pl-9" placeholder="Например: UTM или тема" type="search" />
              </span>
            </label>
            <p role="status" className="sr-only">{searching ? `Найдено настроек: ${results.length}` : ""}</p>
            {searching ? (
              <div className="mt-3 min-h-0 max-h-[28dvh] overflow-y-auto overscroll-contain lg:max-h-none">
                <div className="mb-2 flex items-center justify-between gap-2"><p className="text-[12px] text-text-2">Найдено: {results.length}</p><Button variant="ghost" size="sm" onClick={() => setQuery("")}>Сбросить</Button></div>
                <ul className="space-y-1" aria-label="Результаты поиска настроек">
                  {results.map((item) => <li key={item.id}><button type="button" onClick={() => selectSection(item.section, item.id)} className="w-full rounded-sm border border-transparent p-3 text-left hover:border-line hover:bg-surface-inset"><span className="block text-[14px] font-semibold text-text">{item.label}</span><span className="mt-1 block text-[12px] text-text-2">{SETTINGS_SECTIONS.find((section) => section.id === item.section)?.label}</span></button></li>)}
                </ul>
                {results.length === 0 ? <p className="rounded-sm bg-surface-inset p-3 text-[13px] leading-relaxed text-text-2">По запросу «{query}» ничего не найдено. Попробуй название параметра или сбрось поиск.</p> : null}
              </div>
            ) : <>
              <label className="mt-3 block lg:hidden"><span className="sr-only">Раздел настроек</span><select value={activeSection} onChange={(event) => selectSection(event.currentTarget.value as SettingsSectionId)} className="min-h-11 w-full rounded-xs border border-line bg-surface px-3 text-base text-text">{SETTINGS_SECTIONS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
              <nav className="mt-3 hidden min-h-0 space-y-1 overflow-y-auto overscroll-contain lg:block" aria-label="Разделы настроек Авроры">
                {SETTINGS_SECTIONS.map((item) => {
                  const Icon = item.icon;
                  const active = item.id === activeSection;
                  return <button key={item.id} type="button" aria-current={active ? "page" : undefined} onClick={() => selectSection(item.id)} className={cn("flex min-h-14 w-full items-start gap-3 rounded-sm border px-3 py-3 text-left transition-colors", active ? "border-brand/30 bg-info-soft text-info-text" : "border-transparent text-text-2 hover:border-line hover:bg-surface-inset hover:text-text")}>
                    <Icon className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
                    <span className="min-w-0"><span className="block text-[14px] font-semibold">{item.label}</span><span className="mt-1 block text-[12px] leading-relaxed text-text-2">{item.description}</span></span>
                  </button>;
                })}
              </nav>
            </>}
          </aside>

          <section ref={panelRef} tabIndex={0} id={`settings-${activeSection}-panel`} aria-label={SETTINGS_SECTIONS.find((item) => item.id === activeSection)?.label} className="settings-panel min-h-0 min-w-0 overflow-y-auto overscroll-contain rounded-md pb-6 [scrollbar-gutter:stable]">
            {navigationMessage ? <p role="status" className="mb-3 text-[13px] text-text-2">{navigationMessage}</p> : null}
            {activeSection === "content" || activeSection === "channels" ? <div className="mb-4 flex flex-wrap items-center gap-2 text-[13px]"><span className="text-text-2">Связанные настройки:</span><Button variant="ghost" size="sm" onClick={() => selectSection("integrations", "utm")}>UTM-шаблоны</Button><Button variant="ghost" size="sm" onClick={() => selectSection("dictionary", "blocks")}>Блоки публикаций</Button>{activeSection === "content" ? <Button variant="ghost" size="sm" onClick={() => selectSection("channels", "copy")}>Копирование настроек</Button> : null}</div> : null}
            {activeSection === "profile" ? <AccountProfileSettings /> : null}
            {activeSection === "project" ? <div className="space-y-5"><ProjectBasicsSection /><div data-setting-target="team"><ProjectTeamSection showProjectSummary={false} /></div><div data-setting-target="limits"><AiSection index={1} /></div></div> : null}
            {activeSection === "channels" ? <div className="space-y-5"><div data-setting-target="channels"><ChannelsSection index={0} /></div><ChannelCopySection /></div> : null}
            {activeSection === "content" ? <><SettingsPreviewPanel /><ChannelSettingsCenter view="content" /></> : null}
            {activeSection === "autopilot" ? <div data-setting-target="autopilot"><ChannelSettingsCenter view="autopilot" /></div> : null}
            {activeSection === "dictionary" ? <WritingSettingsSection key={targetId === "blocks" ? "templates" : "rules"} initialView={targetId === "blocks" ? "templates" : "rules"} /> : null}
            {activeSection === "integrations" ? <div className="space-y-5"><TrackingSettingsSection /><div data-setting-target="legal"><LegalSourcesSection /></div><div data-setting-target="bot"><BotSection index={2} /></div></div> : null}
            {activeSection === "notifications" ? <div className="space-y-5"><NotificationSecuritySettings /><div data-setting-target="quiet"><QuietSection index={2} /></div></div> : null}
          </section>
        </div>
      )}
      <ConfirmDialog open={pendingNavigation != null} title="Перейти без сохранения?" description="В этом разделе есть несохранённые изменения. Вернись к форме, чтобы сохранить их, или продолжи переход." confirmLabel="Перейти без сохранения" onCancel={() => setPendingNavigation(null)} onConfirm={() => { if (pendingNavigation) navigateToSection(pendingNavigation.section, pendingNavigation.setting); setPendingNavigation(null); }} />
    </AppShell>
  );
}

export default function SettingsPage() {
  return (
    <Suspense
      fallback={
        <AppShell
          title="Настройки"
          subtitle="Личные предпочтения, параметры проекта и каналов."
      workspace
        >
          <SettingsSkeleton />
        </AppShell>
      }
    >
      <SettingsContent />
    </Suspense>
  );
}
