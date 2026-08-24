"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, Field, Input } from "@/components/ui/primitives";
import { passwordResetRequestOutcome } from "@/lib/password-reset-client";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string>();

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(undefined);
    try {
      const response = await fetch("/api/auth/password/forgot", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = (await response.json().catch(() => null)) as { error?: string } | null;
      const outcome = passwordResetRequestOutcome(response.status, response.ok, data?.error);
      if (outcome === "accepted") {
        // The response is intentionally identical for known and unknown addresses.
        setSent(true);
      } else if (outcome === "rate_limited") {
        setError("Слишком много запросов. Подожди и попробуй позже.");
      } else if (outcome === "temporarily_unavailable") {
        setError("Защита восстановления временно недоступна. Попробуй немного позже.");
      } else {
        setError("Не удалось принять запрос. Попробуй ещё раз.");
      }
    } catch {
      setError("Сеть недоступна. Попробуй ещё раз.");
    } finally {
      setPending(false);
    }
  }

  return (
    <main id="main" className="flex min-h-dvh items-center justify-center bg-bg-section px-5 py-12">
      <Card className="w-full max-w-md p-6 sm:p-8">
        <Link href="/login" className="inline-flex items-center gap-2 text-[14px] font-semibold text-text-2">
          <ArrowLeft className="h-4 w-4" aria-hidden />
          Вернуться ко входу
        </Link>
        <span className="mt-7 flex h-11 w-11 items-center justify-center rounded-full bg-info-soft text-info">
          <Mail className="h-5 w-5" aria-hidden />
        </span>
        <h1 className="mt-4 text-2xl font-extrabold text-text">Восстановить пароль</h1>
        {sent ? (
          <div role="status" className="mt-4 rounded-sm bg-success-soft p-4 text-[14px] leading-relaxed text-success-text">
            Если аккаунт существует и доставка доступна, инструкция будет отправлена. Ссылка действует 30 минут и сработает один раз.
          </div>
        ) : (
          <form onSubmit={submit} className="mt-5">
            <Field label="Почта" htmlFor="reset-email">
              <Input
                id="reset-email"
                name="email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                disabled={pending}
                required
              />
            </Field>
            {error && <p role="alert" className="mt-3 text-[13px] font-medium text-danger-text">{error}</p>}
            <Button type="submit" variant="brand" size="lg" className="mt-5 w-full" loading={pending}>
              Отправить инструкцию
            </Button>
          </form>
        )}
      </Card>
    </main>
  );
}
