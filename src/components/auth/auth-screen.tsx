"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight, Check, Eye, EyeOff, ShieldCheck } from "lucide-react";
import { Logo } from "@/components/brand";
import { HeroProductScene } from "@/components/landing/hero-product-scene";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/primitives";
import { hasPendingProjectInvite } from "@/lib/project-invite-client";
import { useStore } from "@/lib/store";
import styles from "./auth-screen.module.css";

export type AuthMode = "register" | "login";

const PASSWORD_MIN = 8;

function validateEmail(raw: string): string | undefined {
  const value = raw.trim();
  if (!value) return "Введите почту.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) {
    return "Проверьте адрес — похоже, в нём опечатка.";
  }
  return undefined;
}

function signedInDestination() {
  if (hasPendingProjectInvite(typeof window === "undefined" ? null : window.sessionStorage)) {
    return "/invite";
  }
  if (typeof window !== "undefined") {
    const requested = new URLSearchParams(window.location.search).get("next");
    if (requested === "/bot/connect") return requested;
  }
  return "/app/calendar";
}

export function AuthScreen({ mode }: { mode: AuthMode }) {
  const store = useStore();
  const router = useRouter();
  const nameRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [nameError, setNameError] = useState<string>();
  const [emailError, setEmailError] = useState<string>();
  const [passwordError, setPasswordError] = useState<string>();
  const [formError, setFormError] = useState<string>();
  const [pending, setPending] = useState(false);

  const isRegistration = mode === "register";

  useEffect(() => {
    if (store.authReady && store.user) router.replace(signedInDestination());
  }, [router, store.authReady, store.user]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;

    const nextNameError =
      isRegistration && name.trim().length < 2
        ? "Введите имя — хотя бы 2 символа."
        : undefined;
    const nextEmailError = validateEmail(email);
    const nextPasswordError = !password
      ? "Введите пароль."
      : isRegistration && password.length < PASSWORD_MIN
        ? `Используйте не меньше ${PASSWORD_MIN} символов.`
        : undefined;

    setNameError(nextNameError);
    setEmailError(nextEmailError);
    setPasswordError(nextPasswordError);
    setFormError(undefined);

    if (nextNameError) {
      nameRef.current?.focus();
      return;
    }
    if (nextEmailError) {
      emailRef.current?.focus();
      return;
    }
    if (nextPasswordError) {
      passwordRef.current?.focus();
      return;
    }

    setPending(true);
    try {
      const response = await fetch(isRegistration ? "/api/auth/register" : "/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: email.trim(),
          password,
          ...(isRegistration ? { name: name.trim() } : {}),
        }),
      });
      const data = (await response.json().catch(() => null)) as {
        ok?: boolean;
        error?: string;
        retryAfter?: number;
        accountCreated?: boolean;
      } | null;

      if (response.ok && data?.ok) {
        await store.refreshAuth();
        store.toast({
          kind: "success",
          title: isRegistration ? "Аккаунт создан" : "Вход выполнен",
          body: "Открываем платформу.",
        });
        router.replace(signedInDestination());
        return;
      }

      if (response.status === 429 && data?.error === "rate_limited") {
        const minutes = Math.max(1, Math.ceil((data.retryAfter ?? 900) / 60));
        setFormError(`Слишком много попыток. Попробуйте снова через ${minutes} мин.`);
      } else if (response.status === 409 && data?.error === "email_taken") {
        setFormError("Эта почта уже зарегистрирована. Войдите в аккаунт.");
      } else if (response.status === 401 && data?.error === "invalid") {
        setFormError("Почта или пароль не подошли. Проверьте данные и попробуйте снова.");
      } else if (response.status === 422 && data?.error === "bad_email") {
        setEmailError("Проверьте адрес — похоже, в нём опечатка.");
        emailRef.current?.focus();
      } else if (response.status === 422 && data?.error === "bad_password") {
        setPasswordError(`Используйте не меньше ${PASSWORD_MIN} символов.`);
        passwordRef.current?.focus();
      } else if (
        response.status === 503 &&
        data?.error === "session_creation_failed" &&
        data.accountCreated
      ) {
        setFormError("Аккаунт создан, но автоматический вход не завершился. Войдите с тем же паролем.");
      } else {
        setFormError("Не удалось продолжить. Проверьте соединение и попробуйте снова.");
      }
    } catch {
      setFormError("Не удалось продолжить. Проверьте соединение и попробуйте снова.");
    } finally {
      setPending(false);
    }
  }

  return (
    <main id="main" className={styles.page}>
      <header className={styles.header}>
        <Link className={styles.brand} href="/" aria-label="Аврора — на главную">
          <Logo size={34} decorative />
          <span>Аврора</span>
        </Link>
        <Link className={styles.backLink} href="/">
          <ArrowLeft aria-hidden="true" />
          На главную
        </Link>
      </header>

      <div className={styles.shell}>
        <section className={styles.formPanel} aria-labelledby="auth-title">
          <p className={styles.eyebrow}>{isRegistration ? "14 дней бесплатно" : "Личный кабинет"}</p>
          <h1 id="auth-title">{isRegistration ? "Создайте аккаунт" : "С возвращением"}</h1>
          <p className={styles.lead}>
            {isRegistration
              ? "Начните управлять контентом в одном окне. Карта для регистрации не нужна."
              : "Войдите, чтобы продолжить работу с контентом, командой и аналитикой."}
          </p>

          <form className={styles.form} method="post" onSubmit={submit} noValidate>
            {isRegistration ? (
              <div className={styles.field}>
                <label htmlFor="name">Имя</label>
                <Input
                  ref={nameRef}
                  id="name"
                  name="name"
                  type="text"
                  autoComplete="name"
                  placeholder="Как к вам обращаться"
                  value={name}
                  disabled={pending}
                  aria-invalid={nameError ? true : undefined}
                  aria-describedby={nameError ? "name-error" : undefined}
                  onChange={(event) => {
                    setName(event.target.value);
                    if (nameError) setNameError(undefined);
                    if (formError) setFormError(undefined);
                  }}
                />
                {nameError ? <p id="name-error" role="alert">{nameError}</p> : null}
              </div>
            ) : null}

            <div className={styles.field}>
              <label htmlFor="email">Почта</label>
              <Input
                ref={emailRef}
                id="email"
                name="email"
                type="email"
                inputMode="email"
                autoComplete="email"
                placeholder="name@example.com"
                value={email}
                disabled={pending}
                aria-invalid={emailError ? true : undefined}
                aria-describedby={emailError ? "email-error" : undefined}
                onBlur={() => {
                  if (email.trim()) setEmailError(validateEmail(email));
                }}
                onChange={(event) => {
                  setEmail(event.target.value);
                  if (emailError) setEmailError(undefined);
                  if (formError) setFormError(undefined);
                }}
              />
              {emailError ? <p id="email-error" role="alert">{emailError}</p> : null}
            </div>

            <div className={styles.field}>
              <div className={styles.passwordLabel}>
                <label htmlFor="password">Пароль</label>
                {!isRegistration ? <Link href="/forgot-password">Восстановить</Link> : null}
              </div>
              <div className={styles.passwordWrap}>
                <Input
                  ref={passwordRef}
                  id="password"
                  name="password"
                  type={showPassword ? "text" : "password"}
                  autoComplete={isRegistration ? "new-password" : "current-password"}
                  placeholder={isRegistration ? "Минимум 8 символов" : "Введите пароль"}
                  value={password}
                  disabled={pending}
                  aria-invalid={passwordError ? true : undefined}
                  aria-describedby={passwordError ? "password-error" : isRegistration ? "password-hint" : undefined}
                  onChange={(event) => {
                    setPassword(event.target.value);
                    if (passwordError) setPasswordError(undefined);
                    if (formError) setFormError(undefined);
                  }}
                />
                <button
                  type="button"
                  className={styles.passwordToggle}
                  onClick={() => setShowPassword((current) => !current)}
                  aria-label={showPassword ? "Скрыть пароль" : "Показать пароль"}
                >
                  {showPassword ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
                </button>
              </div>
              {passwordError ? (
                <p id="password-error" role="alert">{passwordError}</p>
              ) : isRegistration ? (
                <p id="password-hint" className={styles.hint}>Используйте не меньше 8 символов.</p>
              ) : null}
            </div>

            <div className={styles.formStatus} aria-live="polite">
              {formError ? <p role="alert">{formError}</p> : null}
            </div>

            <Button
              type="submit"
              variant="primary"
              size="lg"
              className={styles.submitButton}
              loading={pending}
            >
              {isRegistration ? "Создать аккаунт" : "Войти в платформу"}
              {!pending ? <ArrowRight aria-hidden="true" /> : null}
            </Button>
          </form>

          <p className={styles.switchCopy}>
            {isRegistration ? "Уже есть аккаунт?" : "Ещё нет аккаунта?"}{" "}
            <Link href={isRegistration ? "/login" : "/register"}>
              {isRegistration ? "Войти" : "Зарегистрироваться"}
            </Link>
          </p>

          <p className={styles.securityNote}>
            <ShieldCheck aria-hidden="true" />
            Пароль защищён и не хранится в открытом виде.
          </p>
        </section>

        <aside className={styles.previewPanel} aria-label="Возможности платформы">
          <div className={styles.previewCopy}>
            <span><Check aria-hidden="true" />Всё готово к работе</span>
            <h2>
              {isRegistration
                ? "Из регистрации — сразу в рабочий календарь"
                : "Всё на месте — продолжайте с календаря"}
            </h2>
            <p>
              {isRegistration
                ? "Подключите каналы, соберите первую неделю и опубликуйте пост без лишних настроек."
                : "Вернитесь к контент-плану, согласованиям и аналитике без повторной настройки."}
            </p>
          </div>
          <div className={styles.previewScene}>
            <HeroProductScene />
          </div>
        </aside>
      </div>
    </main>
  );
}
