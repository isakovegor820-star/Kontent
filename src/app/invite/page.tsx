"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, ShieldCheck, Users } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  PROJECT_INVITE_STORAGE_KEY,
  projectInviteTokenFromHash,
} from "@/lib/project-invite-client";
import { useStore } from "@/lib/store";

type InviteState = "loading" | "ready" | "accepting" | "accepted" | "missing" | "error";

const ERROR_COPY: Record<string, string> = {
  invitation_expired: "Срок приглашения истёк. Попросите владельца проекта создать новое.",
  invitation_revoked: "Приглашение отозвано владельцем проекта.",
  invitation_used: "Это приглашение уже принято.",
  email_mismatch: "Приглашение выдано для другой почты. Войдите в нужный аккаунт.",
  already_member: "Вы уже состоите в этом проекте.",
  rate_limited: "Слишком много попыток. Подождите и попробуйте снова.",
};

export default function ProjectInvitePage() {
  const { authReady, authError, user, refreshAuth } = useStore();
  const router = useRouter();
  const [state, setState] = useState<InviteState>("loading");
  const [message, setMessage] = useState("");
  const tokenRef = useRef<string | null>(null);

  useEffect(() => {
    queueMicrotask(() => {
      let token = projectInviteTokenFromHash(window.location.hash);
      try {
        if (token) sessionStorage.setItem(PROJECT_INVITE_STORAGE_KEY, token);
        else token = sessionStorage.getItem(PROJECT_INVITE_STORAGE_KEY);
      } catch {
        token = null;
      }
      tokenRef.current = token && /^[A-Za-z0-9_-]{43}$/u.test(token) ? token : null;
      if (window.location.hash) window.history.replaceState(null, "", "/invite");
      setState(tokenRef.current ? "ready" : "missing");
    });
  }, []);

  const accept = async () => {
    const token = tokenRef.current;
    if (!token || !user || state === "accepting") return;
    setState("accepting");
    setMessage("");
    try {
      const response = await fetch("/api/project-invitations/accept", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const body = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) {
        setMessage(ERROR_COPY[body?.error ?? ""] ?? "Не удалось принять приглашение. Попробуйте снова.");
        setState("error");
        return;
      }
      try {
        sessionStorage.removeItem(PROJECT_INVITE_STORAGE_KEY);
      } catch {
        // Acceptance is already durable on the server; storage cleanup is best effort.
      }
      tokenRef.current = null;
      setState("accepted");
    } catch {
      setMessage("Сервер не ответил. Приглашение не использовано — попробуйте снова.");
      setState("error");
    }
  };

  if (state === "loading" || !authReady) {
    return (
      <main id="main" className="grid min-h-dvh place-items-center bg-bg px-5 py-10" aria-busy="true">
        <p role="status" className="text-sm font-semibold text-text-2">Открываем приглашение…</p>
      </main>
    );
  }

  return (
    <main id="main" className="grid min-h-dvh place-items-center bg-bg px-5 py-10">
      <section aria-labelledby="invite-title" className="w-full max-w-lg rounded-md border border-line bg-surface p-6 shadow-card sm:p-8">
        <span className="flex h-11 w-11 items-center justify-center rounded-full bg-info-soft text-info-text">
          <Users className="h-5 w-5" aria-hidden />
        </span>
        <h1 id="invite-title" className="mt-5 text-2xl font-extrabold tracking-tight text-text">
          Приглашение в проект
        </h1>

        {state === "missing" ? (
          <>
            <p className="mt-3 text-[15px] leading-relaxed text-text-2">
              В ссылке нет действующего приглашения. Попросите владельца отправить новую ссылку целиком.
            </p>
            <Link href="/" className="mt-6 inline-flex min-h-11 items-center font-semibold text-brand underline underline-offset-4">
              На главную
            </Link>
          </>
        ) : authError ? (
          <div role="alert" className="mt-4">
            <p className="text-[15px] leading-relaxed text-danger-text">
              Не удалось проверить вход. Приглашение сохранено в этом браузере.
            </p>
            <Button className="mt-5" variant="outline" onClick={() => void refreshAuth()}>
              Повторить проверку
            </Button>
          </div>
        ) : !user ? (
          <>
            <p className="mt-3 text-[15px] leading-relaxed text-text-2">
              Войдите с той почтой, на которую выдано приглашение. Ссылка сохранена только в этой вкладке.
            </p>
            <Button className="mt-6 w-full" variant="solid" onClick={() => router.push("/register")}>
              Войти или создать аккаунт
            </Button>
          </>
        ) : state === "accepted" ? (
          <div role="status" aria-live="polite">
            <p className="mt-4 flex items-center gap-2 font-semibold text-success-text">
              <Check className="h-5 w-5" aria-hidden />
              Приглашение принято
            </p>
            <p className="mt-2 text-[15px] leading-relaxed text-text-2">
              Проект добавлен, права подтверждены сервером.
            </p>
            <Button className="mt-6 w-full" variant="solid" onClick={() => router.push("/app/calendar")}>
              Открыть проект
            </Button>
          </div>
        ) : (
          <>
            <p className="mt-3 text-[15px] leading-relaxed text-text-2">
              После подтверждения проект появится в переключателе. Роль и доступ проверит сервер.
            </p>
            <p className="mt-4 flex items-start gap-2 text-sm leading-relaxed text-text-3">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              Ссылка одноразовая и не отображается на странице.
            </p>
            {message ? <p id="invite-error" role="alert" className="mt-4 text-sm font-semibold text-danger-text">{message}</p> : null}
            <Button
              className="mt-6 w-full"
              variant="solid"
              loading={state === "accepting"}
              aria-describedby={message ? "invite-error" : undefined}
              onClick={() => void accept()}
            >
              Принять приглашение
            </Button>
          </>
        )}
      </section>
    </main>
  );
}
