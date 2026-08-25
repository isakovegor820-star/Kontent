"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { KeyRound } from "lucide-react";
import { Button, buttonClassName } from "@/components/ui/button";
import { Card, Field, Input } from "@/components/ui/primitives";
import {
  PASSWORD_MAX,
  PASSWORD_MIN,
  passwordProblemMessage,
  validatePassword,
  type PasswordProblem,
} from "@/lib/password-policy";

type ResetState = "loading" | "ready" | "success" | "invalid" | "expired" | "used";

export default function ResetPasswordPage() {
  const [token, setToken] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [state, setState] = useState<ResetState>("loading");
  const [pending, setPending] = useState(false);
  const [passwordError, setPasswordError] = useState<string>();
  const [confirmError, setConfirmError] = useState<string>();
  const [formError, setFormError] = useState<string>();
  const passwordRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLInputElement>(null);

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
    const passwordProblem = validatePassword(password);
    if (passwordProblem) {
      setPasswordError(passwordProblemMessage(passwordProblem));
      passwordRef.current?.focus();
      return;
    }
    if (password !== confirm) {
      setConfirmError("Пароли не совпадают.");
      confirmRef.current?.focus();
      return;
    }
    setPending(true);
    setPasswordError(undefined);
    setConfirmError(undefined);
    setFormError(undefined);
    try {
      const response = await fetch("/api/auth/password/reset", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const data = (await response.json().catch(() => null)) as {
        ok?: boolean;
        error?: ResetState | "bad_password";
        reason?: PasswordProblem;
      } | null;
      if (response.ok && data?.ok) setState("success");
      else if (data?.error === "expired" || data?.error === "used" || data?.error === "invalid") setState(data.error);
      else if (data?.error === "bad_password") {
        setPasswordError(passwordProblemMessage(data.reason ?? "too_short"));
        passwordRef.current?.focus();
      } else setFormError("Не удалось сменить пароль. Попробуйте ещё раз.");
    } catch {
      setFormError("Сеть недоступна. Попробуйте ещё раз.");
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
            <Link
              className={buttonClassName({ variant: "primary", size: "lg", className: "mt-5 w-full" })}
              href={state === "success" ? "/login" : "/forgot-password"}
            >
              {state === "success" ? "Войти" : "Запросить новую ссылку"}
            </Link>
          </div>
        ) : (
          <form onSubmit={submit} className="mt-5 space-y-4">
            <Field label="Новый пароль" htmlFor="new-password" error={passwordError} messageId="new-password-error">
              <Input ref={passwordRef} id="new-password" name="password" type="password" autoComplete="new-password" minLength={PASSWORD_MIN} maxLength={PASSWORD_MAX} value={password} aria-invalid={passwordError ? true : undefined} aria-describedby={passwordError ? "new-password-error" : undefined} onChange={(event) => { setPassword(event.target.value); if (passwordError) setPasswordError(undefined); if (formError) setFormError(undefined); }} />
            </Field>
            <Field label="Повтори пароль" htmlFor="confirm-password" error={confirmError} messageId="confirm-password-error">
              <Input ref={confirmRef} id="confirm-password" name="password-confirmation" type="password" autoComplete="new-password" minLength={PASSWORD_MIN} maxLength={PASSWORD_MAX} value={confirm} aria-invalid={confirmError ? true : undefined} aria-describedby={confirmError ? "confirm-password-error" : undefined} onChange={(event) => { setConfirm(event.target.value); if (confirmError) setConfirmError(undefined); if (formError) setFormError(undefined); }} />
            </Field>
            {formError && <p role="alert" className="text-[13px] font-medium text-danger-text">{formError}</p>}
            <Button type="submit" variant="brand" size="lg" className="w-full" loading={pending}>
              Сменить пароль
            </Button>
          </form>
        )}
      </Card>
    </main>
  );
}
