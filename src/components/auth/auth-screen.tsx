"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  Bot,
  Check,
  Eye,
  EyeOff,
  ShieldCheck,
  UsersRound,
} from "lucide-react";
import { Logo } from "@/components/brand";
import { HeroProductScene } from "@/components/landing/hero-product-scene";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/primitives";
import { hasPendingProjectInvite } from "@/lib/project-invite-client";
import {
  PASSWORD_MAX,
  PASSWORD_MIN,
  passwordProblemMessage,
  validatePassword,
  type PasswordProblem,
} from "@/lib/password-policy";
import { useStore } from "@/lib/store";
import styles from "./auth-screen.module.css";

export type AuthMode = "register" | "login";
export type AuthIntent = "platform" | "admin";

function validateEmail(raw: string): string | undefined {
  const value = raw.trim();
  if (!value) return "Введите почту.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) {
    return "Проверьте адрес — похоже, в нём опечатка.";
  }
  return undefined;
}

function signedInDestination(intent: AuthIntent, onboarded = true) {
  if (intent === "admin") return "/admin#overview";
  if (hasPendingProjectInvite(typeof window === "undefined" ? null : window.sessionStorage)) {
    return "/invite";
  }
  if (typeof window !== "undefined") {
    const requested = new URLSearchParams(window.location.search).get("next");
    if (requested === "/bot/connect") return requested;
  }
  if (!onboarded) return "/app/onboarding";
  return "/app/calendar";
}

export function AuthScreen({ mode, intent = "platform" }: { mode: AuthMode; intent?: AuthIntent }) {
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
  const isAdmin = intent === "admin";

  useEffect(() => {
    if (store.authReady && store.user) {
      router.replace(signedInDestination(intent, store.user.onboarded));
    }
  }, [intent, router, store.authReady, store.user]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;

    const nextNameError =
      isRegistration && name.trim().length < 2
        ? "Введите имя — хотя бы 2 символа."
        : undefined;
    const nextEmailError = validateEmail(email);
    const passwordProblem = isRegistration ? validatePassword(password) : undefined;
    const nextPasswordError = !password
      ? "Введите пароль."
      : passwordProblem
        ? passwordProblemMessage(passwordProblem)
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
        reason?: PasswordProblem;
        retryAfter?: number;
        accountCreated?: boolean;
      } | null;

      if (response.ok && data?.ok) {
        await store.refreshAuth();
        store.toast({
          kind: "success",
          title: isRegistration ? "Аккаунт создан" : "Вход выполнен",
          body: isAdmin ? "Открываем центр управления." : "Открываем платформу.",
        });
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
        setPasswordError(passwordProblemMessage(data.reason ?? "too_short"));
        passwordRef.current?.focus();
      } else if (response.status === 403 && data?.error === "forbidden") {
        setFormError("Откройте страницу и отправьте форму с одного и того же адреса.");
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
          <p className={styles.eyebrow}>
            {isAdmin ? "Защищённый контур" : isRegistration ? "Без банковской карты" : "Личный кабинет"}
          </p>
          <h1 id="auth-title">
            {isAdmin ? "Вход в центр управления" : isRegistration ? "Создайте аккаунт" : "С возвращением"}
          </h1>
          <p className={styles.lead}>
            {isAdmin
              ? "Только для администраторов Авроры. После входа доступ будет проверен сервером."
              : isRegistration
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
                {!isRegistration && !isAdmin ? <Link href="/forgot-password">Восстановить</Link> : null}
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
                  minLength={isRegistration ? PASSWORD_MIN : undefined}
                  maxLength={isRegistration ? PASSWORD_MAX : undefined}
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
              {isAdmin ? "Войти в админ-панель" : isRegistration ? "Создать аккаунт" : "Войти в платформу"}
              {!pending ? <ArrowRight aria-hidden="true" /> : null}
            </Button>

            {isRegistration ? (
              <p className={styles.legalNote}>
                Создавая аккаунт, вы принимаете <Link href="/terms">условия использования</Link>{" "}
                и подтверждаете, что ознакомились с <Link href="/privacy">политикой конфиденциальности</Link>.
              </p>
            ) : null}
          </form>

          {!isAdmin ? (
            <p className={styles.switchCopy}>
              {isRegistration ? "Уже есть аккаунт?" : "Ещё нет аккаунта?"}{" "}
              <Link href={isRegistration ? "/login" : "/register"}>
                {isRegistration ? "Войти" : "Зарегистрироваться"}
              </Link>
            </p>
          ) : null}

          <p className={styles.securityNote}>
            <ShieldCheck aria-hidden="true" />
            {isAdmin
              ? "Доступ получают только аккаунты из серверного списка администраторов."
              : "Пароль защищён и не хранится в открытом виде."}
          </p>
        </section>

        {isAdmin ? (
          <aside className={styles.previewPanel} aria-label="Возможности центра управления">
            <div className={styles.adminPreview}>
              <div className={styles.adminPulse}>
                <span aria-hidden="true" />
                Защищённое подключение
              </div>
              <h2>Вся Аврора — под контролем</h2>
              <p>
                Состояние платформы, пользователи, каналы, публикации и бот собраны в одном центре.
              </p>
              <ul className={styles.adminFeatures}>
                <li>
                  <span className={styles.adminFeatureIcon}>
                    <Activity aria-hidden="true" />
                  </span>
                  <span>
                    <strong>Пульс системы</strong>
                    <small>Сервисы, очереди и ошибки в реальном времени</small>
                  </span>
                </li>
                <li>
                  <span className={styles.adminFeatureIcon}>
                    <UsersRound aria-hidden="true" />
                  </span>
                  <span>
                    <strong>Пользователи и каналы</strong>
                    <small>Аккаунты, подключения и активность проектов</small>
                  </span>
                </li>
                <li>
                  <span className={styles.adminFeatureIcon}>
                    <Bot aria-hidden="true" />
                  </span>
                  <span>
                    <strong>Центр Telegram-бота</strong>
                    <small>Доставки, доступы и проверка уведомлений</small>
                  </span>
                </li>
              </ul>
            </div>
          </aside>
        ) : (
          <aside className={styles.previewPanel} aria-label="Возможности платформы">
            <div className={styles.previewCopy}>
              <span><Check aria-hidden="true" />Всё готово к работе</span>
              <h2>
                {isRegistration
                  ? "Из регистрации — в понятную настройку"
                  : "Всё на месте — продолжайте с календаря"}
              </h2>
              <p>
                {isRegistration
                  ? "Настройте проект, подключите Telegram и сохраните первый материал за пять коротких шагов."
                  : "Вернитесь к контент-плану, согласованиям и аналитике без повторной настройки."}
              </p>
            </div>
            <div className={styles.previewScene}>
              <HeroProductScene />
            </div>
          </aside>
        )}
      </div>
    </main>
  );
}
