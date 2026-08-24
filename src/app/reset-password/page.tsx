"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, Field, Input } from "@/components/ui/primitives";

type ResetState = "loading" | "ready" | "success" | "invalid" | "expired" | "used";

export default function ResetPasswordPage() {
  const [token, setToken] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [state, setState] = useState<ResetState>("loading");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const raw = params.get("token") ?? "";
    window.history.replaceState(null, "", window.location.pathname);
    const reveal = window.setTimeout(() => {
      setToken(raw);
      setState(raw ? "ready" : "invalid");
    }, 0);
    return () => window.clearTimeout(reveal);
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (pending || state !== "ready") return;
    if (password.length < 8) return setError("Пароль — минимум 8 символов.");
    if (password !== confirm) return setError("Пароли не совпадают.");
    setPending(true);
    setError(undefined);
    try {
      const response = await fetch("/api/auth/password/reset", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const data = (await response.json().catch(() => null)) as { ok?: boolean; error?: ResetState | "bad_password" } | null;
      if (response.ok && data?.ok) setState("success");
      else if (data?.error === "expired" || data?.error === "used" || data?.error === "invalid") setState(data.error);
      else setError("Не удалось сменить пароль. Попробуй ещё раз.");
    } catch {
      setError("Сеть недоступна. Попробуй ещё раз.");
    } finally {
      setPending(false);
    }
  }

  const terminal = {
    success: "Пароль изменён. Все прежние сессии завершены — войди заново.",
    invalid: "Ссылка недействительна.",
    expired: "Ссылка истекла. Запроси новую — она действует 30 минут.",
    used: "Эта ссылка уже использована. Для повторной смены запроси новую.",
  } as const;

  return (
    <main id="main" className="flex min-h-dvh items-center justify-center bg-bg-section px-5 py-12">
      <Card className="w-full max-w-md p-6 sm:p-8">
        <span className="flex h-11 w-11 items-center justify-center rounded-full bg-info-soft text-info">
          <KeyRound className="h-5 w-5" aria-hidden />
        </span>
        <h1 className="mt-4 text-2xl font-extrabold text-text">Новый пароль</h1>
        {state === "loading" ? (
          <p className="mt-4 text-[14px] text-text-2">Проверяю ссылку…</p>
        ) : state !== "ready" ? (
          <div className="mt-4">
            <p role="status" className="rounded-sm bg-surface-inset p-4 text-[14px] leading-relaxed text-text-2">
              {terminal[state]}
            </p>
            <Link href={state === "success" ? "/login" : "/forgot-password"}>
              <Button variant="brand" size="lg" className="mt-5 w-full">
                {state === "success" ? "Войти" : "Запросить новую ссылку"}
              </Button>
            </Link>
          </div>
        ) : (
          <form onSubmit={submit} className="mt-5 space-y-4">
            <Field label="Новый пароль" htmlFor="new-password">
              <Input id="new-password" name="password" type="password" autoComplete="new-password" minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} />
            </Field>
            <Field label="Повтори пароль" htmlFor="confirm-password">
              <Input id="confirm-password" name="password-confirmation" type="password" autoComplete="new-password" minLength={8} value={confirm} onChange={(event) => setConfirm(event.target.value)} />
            </Field>
            {error && <p role="alert" className="text-[13px] font-medium text-danger-text">{error}</p>}
            <Button type="submit" variant="brand" size="lg" className="w-full" loading={pending}>
              Сменить пароль
            </Button>
          </form>
        )}
      </Card>
    </main>
  );
}
