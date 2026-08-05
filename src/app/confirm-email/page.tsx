"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AtSign } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/primitives";

type ConfirmState = "loading" | "confirmed" | "already_confirmed" | "invalid" | "expired" | "used" | "email_taken" | "unavailable";

export default function ConfirmEmailPage() {
  const [state, setState] = useState<ConfirmState>("loading");
  const [requestId, setRequestId] = useState("");
  const submitted = useRef(false);

  useEffect(() => {
    if (submitted.current) return;
    submitted.current = true;
    const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const token = params.get("token") ?? "";
    window.history.replaceState(null, "", window.location.pathname);
    if (!token) {
      const timer = window.setTimeout(() => setState("invalid"), 0);
      return () => window.clearTimeout(timer);
    }
    const controller = new AbortController();
    fetch("/api/settings/profile/email/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
      signal: controller.signal,
    })
      .then(async (response) => {
        const body = (await response.json().catch(() => null)) as
          | { ok?: boolean; status?: ConfirmState; error?: ConfirmState; requestId?: string }
          | null;
        setRequestId(body?.requestId ?? "");
        if (response.ok && body?.ok) {
          setState(body.status === "already_confirmed" ? "already_confirmed" : "confirmed");
          return;
        }
        const known = body?.error;
        setState(
          known === "invalid" || known === "expired" || known === "used" || known === "email_taken"
            ? known
            : "unavailable",
        );
      })
      .catch((error) => {
        if ((error as Error).name !== "AbortError") setState("unavailable");
      });
    return () => controller.abort();
  }, []);

  const copy: Record<ConfirmState, { title: string; body: string }> = {
    loading: { title: "Подтверждаем email", body: "Проверяем одноразовую ссылку…" },
    confirmed: { title: "Email подтверждён", body: "Новый адрес сохранён в профиле. Теперь его можно использовать для входа." },
    already_confirmed: { title: "Email уже подтверждён", body: "Эта ссылка уже сработала. Дополнительных действий не требуется." },
    invalid: { title: "Ссылка недействительна", body: "Открой ссылку из последнего письма или запроси изменение email заново." },
    expired: { title: "Ссылка истекла", body: "Запроси изменение email ещё раз — новая ссылка будет действовать один час." },
    used: { title: "Ссылка больше не действует", body: "Был создан более новый запрос. Используй ссылку из последнего письма." },
    email_taken: { title: "Email уже занят", body: "Этот адрес успели привязать к другому аккаунту. Укажи другой email в настройках." },
    unavailable: { title: "Не удалось подтвердить email", body: "Проверь соединение и снова открой ссылку из письма." },
  };

  return (
    <main id="main" className="flex min-h-dvh items-center justify-center bg-bg-section px-5 py-12">
      <Card className="w-full max-w-md p-6 sm:p-8">
        <span className="flex h-11 w-11 items-center justify-center rounded-full bg-info-soft text-info">
          <AtSign className="h-5 w-5" aria-hidden />
        </span>
        <div role="status" aria-live="polite">
          <h1 className="mt-4 text-2xl font-extrabold text-text">{copy[state].title}</h1>
          <p className="mt-3 text-[14px] leading-relaxed text-text-2">{copy[state].body}</p>
        </div>
        {requestId && state !== "confirmed" && state !== "already_confirmed" && (
          <p className="mt-3 font-mono text-[12px] text-text-3">ID запроса: {requestId}</p>
        )}
        {state !== "loading" && (
          <Link href="/app/settings?section=general">
            <Button variant="brand" size="lg" className="mt-6 w-full">
              Открыть профиль
            </Button>
          </Link>
        )}
      </Card>
    </main>
  );
}
