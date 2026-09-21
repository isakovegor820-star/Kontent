"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, ShieldCheck, Users } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  clearProjectInviteToken,
  readProjectInvite,
  saveProjectInviteToken,
} from "@/lib/project-invite-client";
import { useStore } from "@/lib/store";

type InviteState = "loading" | "ready" | "accepting" | "switching" | "accepted" | "missing" | "unavailable";

const ERROR_COPY: Record<string, string> = {
  invitation_expired: "Срок приглашения истёк. Попросите владельца проекта создать новое.",
  invitation_revoked: "Приглашение отозвано. Попросите владельца проекта отправить новую ссылку.",
  invitation_used: "Это приглашение уже принято. Если вы принимали его, найдите проект в списке своих проектов.",
  invitation_not_found: "Приглашение не найдено или проект недоступен. Попросите владельца отправить новую ссылку.",
  invalid_token: "Ссылка приглашения некорректна. Попросите владельца отправить её целиком.",
  email_mismatch: "Приглашение выдано для другой почты. Войдите в другой аккаунт с адресом, который указал владелец проекта.",
  already_member: "Вы уже состоите в этом проекте. Откройте список своих проектов.",
  unauthorized: "Сессия завершилась. Войдите снова с почтой, на которую выдано приглашение.",
  rate_limited: "Слишком много попыток. Подождите и попробуйте снова.",
  forbidden_origin: "Не удалось проверить адрес страницы. Снова откройте исходную ссылку приглашения.",
};
const TERMINAL_ERRORS = new Set([
  "invitation_expired", "invitation_revoked", "invitation_used", "invitation_not_found", "invalid_token", "already_member",
]);
const STORAGE_MESSAGE = "Браузер не позволяет сохранить приглашение для входа. Разрешите хранение данных этого сайта и повторите переход ко входу. Исходную ссылку можно открыть в другом браузере.";

export default function ProjectInvitePage() {
  const { authReady, authError, user, refreshAuth } = useStore();
  const router = useRouter();
  const [state, setState] = useState<InviteState>("loading");
  const [error, setError] = useState<{ code: string; message: string; account: string } | null>(null);
  const [storageWarning, setStorageWarning] = useState(false);
  const [loginRequested, setLoginRequested] = useState(false);
  const tokenRef = useRef<string | null>(null);
  const sequenceRef = useRef(0);
  const busyRef = useRef(false);
  const account = [user?.id ?? "", user?.email ?? ""].join(":");
  const message = error && (error.account === account || state === "unavailable" || (error.code === "unauthorized" && !user)) ? error.message : "";
  const errorCode = message ? error?.code : undefined;
  const busy = state === "accepting" || state === "switching";

  useEffect(() => {
    let disposed = false;
    const load = () => {
      if (disposed) return;
      sequenceRef.current += 1;
      busyRef.current = false;
      const { token, stored } = readProjectInvite(window.location.hash);
      tokenRef.current = token;
      // Keep the fragment when storage is blocked so reload still has the original link.
      if (stored && window.location.hash) window.history.replaceState(window.history.state, "", "/invite");
      setStorageWarning(!stored);
      setLoginRequested(false);
      setError(null);
      setState(token ? "ready" : "missing");
    };
    const onHashChange = () => {
      // The skip-to-content anchor is unrelated to the pending invitation.
      if (window.location.hash && window.location.hash !== "#main") load();
    };
    queueMicrotask(load);
    window.addEventListener("hashchange", onHashChange);
    return () => {
      disposed = true;
      sequenceRef.current += 1;
      window.removeEventListener("hashchange", onHashChange);
    };
  }, []);

  useEffect(() => {
    // Wait for both the server logout and the store's confirmed anonymous state.
    // Otherwise AuthScreen immediately redirects the old account back to /invite.
    if (loginRequested && authReady && !authError && !user) router.replace("/login");
  }, [loginRequested, authReady, authError, user, router]);

  const goToLogin = async () => {
    const token = tokenRef.current;
    if (!token || busyRef.current) return;
    if (!saveProjectInviteToken(token)) {
      setStorageWarning(true);
      return;
    }
    setStorageWarning(false);
    if (window.location.hash) window.history.replaceState(window.history.state, "", "/invite");
    if (!user) {
      router.push("/login");
      return;
    }
    const sequence = ++sequenceRef.current;
    busyRef.current = true;
    setState("switching");
    setError(null);
    try {
      const response = await fetch("/api/auth/logout", { method: "POST", signal: AbortSignal.timeout(15_000) });
      const body = await response.json().catch(() => null) as { ok?: boolean } | null;
      if (!response.ok || body?.ok !== true) throw new Error("logout_failed");
      if (sequence !== sequenceRef.current) return;
      setLoginRequested(true);
      await refreshAuth();
    } catch {
      if (sequence === sequenceRef.current) {
        setLoginRequested(false);
        setError({ code: "logout_failed", message: "Не удалось завершить выход из аккаунта. Приглашение сохранено. Попробуйте ещё раз.", account });
      }
    } finally {
      if (sequence === sequenceRef.current) {
        busyRef.current = false;
        setState("ready");
      }
    }
  };

  const accept = async () => {
    const token = tokenRef.current;
    if (!token || !user || busyRef.current) return;
    const sequence = ++sequenceRef.current;
    busyRef.current = true;
    setState("accepting");
    setError(null);
    try {
      const response = await fetch("/api/project-invitations/accept", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
        signal: AbortSignal.timeout(15_000),
      });
      const body = await response.json().catch(() => null) as { ok?: boolean; error?: string } | null;
      if (sequence !== sequenceRef.current) return;
      if (!response.ok) {
        const code = response.status === 401 ? "unauthorized" : body?.error ?? "server";
        setError({ code, message: ERROR_COPY[code] ?? "Не удалось принять приглашение. Попробуйте снова.", account });
        if (TERMINAL_ERRORS.has(code)) {
          clearProjectInviteToken(undefined, token);
          tokenRef.current = null;
          setState("unavailable");
        } else {
          setState("ready");
        }
        if (code === "unauthorized") await refreshAuth();
        return;
      }
      if (body?.ok !== true) throw new Error("invalid_response");
      clearProjectInviteToken(undefined, token);
      tokenRef.current = null;
      if (window.location.hash) window.history.replaceState(window.history.state, "", "/invite");
      setStorageWarning(false);
      setState("accepted");
    } catch {
      if (sequence === sequenceRef.current) {
        setError({ code: "network", message: "Не удалось получить подтверждение от сервера. Проверьте соединение и попробуйте снова. Если приглашение уже принято, проект будет в списке ваших проектов.", account });
        setState("ready");
      }
    } finally {
      if (sequence === sequenceRef.current) busyRef.current = false;
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
        <h1 id="invite-title" className="mt-5 text-2xl font-extrabold tracking-tight text-text">Приглашение в проект</h1>

        {state === "missing" ? (
          <>
            <p className="mt-3 text-[15px] leading-relaxed text-text-2">
              В ссылке нет действующего приглашения. Снова откройте исходную ссылку целиком или попросите владельца отправить новую.
            </p>
            <Link href="/" className="mt-6 inline-flex min-h-11 items-center font-semibold text-brand underline underline-offset-4">На главную</Link>
          </>
        ) : state === "unavailable" ? (
          <>
            <p role="alert" className="mt-4 text-[15px] leading-relaxed text-text-2">{message}</p>
            <Link href="/app/settings?section=project" className="mt-6 inline-flex min-h-11 items-center font-semibold text-brand underline underline-offset-4">Перейти к проектам</Link>
          </>
        ) : state === "accepted" ? (
          <div role="status" aria-live="polite">
            <p className="mt-4 flex items-center gap-2 font-semibold text-success-text"><Check className="h-5 w-5" aria-hidden />Приглашение принято</p>
            <p className="mt-2 text-[15px] leading-relaxed text-text-2">Проект добавлен, права подтверждены сервером.</p>
            <Button className="mt-6 w-full" variant="solid" onClick={() => router.push("/app/calendar")}>Открыть проект</Button>
          </div>
        ) : (
          <>
            {user ? (
              <p className="mt-4 break-words rounded-sm bg-surface-inset p-3 text-sm text-text-2">
                Вы вошли как <strong>{user.email || user.name}</strong>.
                {user.email && user.email.includes("@") ? "" : " У этого аккаунта не указана почта для приглашения."}
              </p>
            ) : null}
            <p className="mt-3 text-[15px] leading-relaxed text-text-2">
              Войти нужно с той почтой, которую владелец указал при создании приглашения.
              После принятия проект появится в списке ваших проектов.
            </p>
            <p className="mt-4 flex items-start gap-2 text-sm leading-relaxed text-text-3">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              Ссылка одноразовая и предназначена только получателю.
            </p>
            {storageWarning ? <p role="status" className="mt-4 text-sm text-text-2">{STORAGE_MESSAGE}</p> : null}
            {message ? <p id="invite-error" role="alert" className="mt-4 text-sm font-semibold text-danger-text">{message}</p> : null}
            {authError ? (
              <div role="alert" className="mt-4">
                <p className="text-sm text-danger-text">Не удалось проверить вход. Повторите проверку, чтобы продолжить.</p>
                <Button className="mt-5" variant="outline" disabled={busy} onClick={() => void refreshAuth()}>Повторить проверку</Button>
              </div>
            ) : !user || errorCode === "unauthorized" ? (
              <Button className="mt-6 w-full" variant="solid" loading={state === "switching"} onClick={() => void goToLogin()}>Войти или создать аккаунт</Button>
            ) : (
              <div className="mt-6 space-y-3">
                <Button className="w-full" variant="solid" loading={state === "accepting"} disabled={state === "switching" || errorCode === "email_mismatch"} aria-describedby={message ? "invite-error" : undefined} onClick={() => void accept()}>
                  Принять приглашение
                </Button>
                <Button className="w-full" variant="outline" loading={state === "switching"} disabled={state === "accepting"} onClick={() => void goToLogin()}>Войти в другой аккаунт</Button>
                <p className="text-xs leading-relaxed text-text-3">При смене аккаунта приглашение сохранится в этой вкладке.</p>
              </div>
            )}
          </>
        )}
      </section>
    </main>
  );
}
