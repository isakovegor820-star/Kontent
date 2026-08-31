"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  CheckCircle2,
  Loader2,
  MessageCircle,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";

import { buttonClassName, Button } from "@/components/ui/button";
import { clearBotConnectionToken, consumeBotConnectionToken } from "@/lib/bot-connect-token";

type InspectionState = "invalid" | "pending" | "expired" | "revoked" | "confirmed";

type Inspection = {
  ok?: boolean;
  state?: InspectionState;
  authenticated?: boolean;
  moveRequired?: boolean;
  chatLinkedToAnotherAccount?: boolean;
  accountLinkedToAnotherChat?: boolean;
  accountEnabled?: boolean;
  telegram?: { username?: string | null; displayName?: string | null };
  account?: { name?: string | null; email?: string | null } | null;
  bot?: string | null;
};

type ViewState = "loading" | "ready" | "confirming" | "connected" | "invalid" | "expired" | "revoked" | "used" | "disabled" | "error";

function readStoredToken(): string | null {
  return consumeBotConnectionToken({
    location: window.location,
    history: window.history,
    storage: window.sessionStorage,
  });
}

function telegramUrl(bot: string | null | undefined): string {
  return bot ? `https://t.me/${bot}` : "https://t.me";
}

export default function BotConnectPage() {
  const tokenRef = useRef<string | null>(null);
  const [view, setView] = useState<ViewState>("loading");
  const [inspection, setInspection] = useState<Inspection | null>(null);

  const inspect = useCallback(async () => {
    const token = tokenRef.current;
    setView("loading");
    try {
      const response = await fetch("/api/bot/connect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "inspect", token: token || "" }),
      });
      const body = await response.json().catch(() => null) as Inspection | null;
      if (!response.ok || !body?.ok) {
        setView("error");
        return;
      }
      setInspection(body);
      if (body.state === "pending" && body.authenticated && body.accountEnabled === false) setView("disabled");
      else if (body.state === "pending") setView("ready");
      else if (body.state === "confirmed") setView("connected");
      else if (body.state === "expired") setView("expired");
      else if (body.state === "revoked") setView("revoked");
      else setView("invalid");
    } catch {
      setView("error");
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    const readTokenAndInspect = () => {
      if (!mounted) return;
      try {
        tokenRef.current = readStoredToken();
      } catch {
        tokenRef.current = null;
      }
      void inspect();
    };
    queueMicrotask(readTokenAndInspect);
    window.addEventListener("hashchange", readTokenAndInspect);
    return () => {
      mounted = false;
      window.removeEventListener("hashchange", readTokenAndInspect);
    };
  }, [inspect]);

  async function confirm() {
    const token = tokenRef.current;
    if (!token || view === "confirming") return;
    setView("confirming");
    try {
      const response = await fetch("/api/bot/connect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "confirm",
          token,
          allowMove: inspection?.moveRequired === true,
        }),
      });
      const body = await response.json().catch(() => null) as { ok?: boolean; error?: string; bot?: string | null } | null;
      if (response.ok && body?.ok) {
        clearBotConnectionToken(window.sessionStorage);
        setInspection((current) => ({ ...current, bot: body.bot ?? current?.bot }));
        setView("connected");
        return;
      }
      if (body?.error === "expired") setView("expired");
      else if (body?.error === "revoked") setView("revoked");
      else if (body?.error === "used") setView("used");
      else if (body?.error === "account_disabled") setView("disabled");
      else if (body?.error === "unauthorized") setView("ready");
      else setView("error");
    } catch {
      setView("error");
    }
  }

  const telegramName = inspection?.telegram?.username
    ? `@${inspection.telegram.username}`
    : inspection?.telegram?.displayName || "этот Telegram-чат";
  const accountName = inspection?.account?.name || inspection?.account?.email || "аккаунт Авроры";
  const loginHref = "/login?next=%2Fbot%2Fconnect";
  const botHref = telegramUrl(inspection?.bot);

  let title = "Подключение Telegram";
  let body = "Проверяем одноразовую ссылку…";
  let icon = <Loader2 className="h-6 w-6 animate-spin motion-reduce:animate-none" aria-hidden="true" />;
  let tone = "bg-info-soft text-info-text";

  if (view === "ready") {
    title = inspection?.authenticated ? "Подключите этот чат" : "Войдите в Аврору";
    body = inspection?.authenticated
      ? `Telegram ${telegramName} будет связан с аккаунтом «${accountName}».`
      : `После входа подтвердите, что Telegram ${telegramName} нужно связать с вашим аккаунтом.`;
    icon = <MessageCircle className="h-6 w-6" aria-hidden="true" />;
  } else if (view === "confirming") {
    title = "Подключаем чат";
    body = "Сохраняем связь с аккаунтом и проверяем доступ…";
  } else if (view === "connected") {
    title = "Чат подключён";
    body = "Команды и уведомления Авроры теперь доступны в Telegram.";
    icon = <CheckCircle2 className="h-6 w-6" aria-hidden="true" />;
    tone = "bg-success-soft text-success-text";
  } else if (view === "expired") {
    title = "Ссылка истекла";
    body = "Откройте бота и запросите новую ссылку. Она будет действовать 15 минут.";
    icon = <TriangleAlert className="h-6 w-6" aria-hidden="true" />;
    tone = "bg-danger-soft text-danger-text";
  } else if (view === "revoked" || view === "used") {
    title = "Ссылка больше не действует";
    body = "В Telegram была создана более новая ссылка или этот запрос уже использован.";
    icon = <TriangleAlert className="h-6 w-6" aria-hidden="true" />;
    tone = "bg-danger-soft text-danger-text";
  } else if (view === "disabled") {
    title = "Доступ к боту приостановлен";
    body = "Проекты и публикации сохранены. Обратитесь к администратору Авроры.";
    icon = <TriangleAlert className="h-6 w-6" aria-hidden="true" />;
    tone = "bg-danger-soft text-danger-text";
  } else if (view === "invalid") {
    title = "Ссылка недействительна";
    body = "Запросите новую ссылку командой /start или /connect в Telegram.";
    icon = <TriangleAlert className="h-6 w-6" aria-hidden="true" />;
    tone = "bg-danger-soft text-danger-text";
  } else if (view === "error") {
    title = "Не удалось проверить подключение";
    body = "Проверьте соединение и повторите проверку. Одноразовая ссылка пока не использована.";
    icon = <TriangleAlert className="h-6 w-6" aria-hidden="true" />;
    tone = "bg-danger-soft text-danger-text";
  }

  return (
    <main id="main" className="grid min-h-dvh place-items-center bg-bg-section px-5 py-10">
      <section aria-labelledby="bot-connect-title" className="w-full max-w-lg rounded-xl border border-line bg-surface p-6 shadow-card sm:p-8">
        <span className={`flex h-12 w-12 items-center justify-center rounded-full ${tone}`}>
          {icon}
        </span>
        <div className="mt-5" role="status" aria-live="polite" aria-busy={view === "loading" || view === "confirming"}>
          <h1 id="bot-connect-title" className="text-balance text-2xl font-extrabold tracking-tight text-text">
            {title}
          </h1>
          <p className="mt-3 max-w-[65ch] text-pretty text-base leading-relaxed text-text-2">
            {body}
          </p>
        </div>

        {view === "ready" && inspection?.moveRequired ? (
          <div className="mt-5 rounded-md bg-danger-soft p-4 text-sm leading-relaxed text-danger-text" role="alert">
            {inspection.chatLinkedToAnotherAccount
              ? "Этот чат уже связан с другим аккаунтом. Подтверждение перенесёт его в текущий аккаунт."
              : "К аккаунту уже подключён другой Telegram-чат. Подтверждение заменит его этим чатом."}
          </div>
        ) : null}

        {view === "ready" ? (
          inspection?.authenticated ? (
            <Button
              className="mt-6 w-full"
              variant="primary"
              size="lg"
              onClick={() => void confirm()}
            >
              {inspection.moveRequired ? "Перенести подключение" : "Подключить этот чат"}
            </Button>
          ) : (
            <Link href={loginHref} className={buttonClassName({ className: "mt-6 w-full", variant: "primary", size: "lg" })}>
              Войти и подтвердить
            </Link>
          )
        ) : null}

        {view === "confirming" ? (
          <Button className="mt-6 w-full" variant="primary" size="lg" loading disabled>
            Подключить этот чат
          </Button>
        ) : null}

        {view === "connected" ? (
          <a href={botHref} className={buttonClassName({ className: "mt-6 w-full", variant: "primary", size: "lg" })}>
            Вернуться в Telegram
          </a>
        ) : null}

        {view === "error" ? (
          <Button className="mt-6 w-full" variant="secondary" size="lg" onClick={() => void inspect()}>
            Повторить проверку
          </Button>
        ) : null}

        {view === "invalid" || view === "expired" || view === "revoked" || view === "used" ? (
          <a href={botHref} className={buttonClassName({ className: "mt-6 w-full", variant: "secondary", size: "lg" })}>
            Запросить ссылку в Telegram
          </a>
        ) : null}

        <p className="mt-5 flex items-start gap-2 text-sm leading-relaxed text-text-3">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          Ссылка одноразовая. Бот не получает пароль и не публикует без отдельного подтверждения.
        </p>
      </section>
    </main>
  );
}
