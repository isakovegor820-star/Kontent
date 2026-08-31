"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  AtSign,
  Check,
  Clock3,
  ImagePlus,
  Languages,
  Phone,
  RotateCcw,
  Save,
  Trash2,
  UserRound,
} from "lucide-react";

import { AvatarEditorDialog } from "@/components/app/avatar-editor-dialog";
import { useAppTheme } from "@/components/app/theme-provider";
import { Button } from "@/components/ui/button";
import { Badge, Card, Field, Input, Textarea } from "@/components/ui/primitives";
import type { AccountProfile } from "@/lib/account-settings";
import {
  PROFILE_AVATAR_ACCEPTED_TYPES,
  PROFILE_AVATAR_UPLOAD_MAX_BYTES,
} from "@/lib/profile-avatar-contract.mjs";
import { useStore } from "@/lib/store";

type ReauthMethod = "password" | "telegram" | "vk" | "unavailable";

type ProfileResponse = {
  ok?: boolean;
  error?: string;
  requestId?: string;
  profile?: AccountProfile;
  reauthMethod?: ReauthMethod;
  pendingEmail?: { email: string; expiresAt: string } | null;
  pendingPhone?: { phone: string; expiresAt: string } | null;
  phoneVerification?: { state?: "temporary" | "unavailable"; temporary?: boolean };
  savedAt?: string;
};

const TIMEZONES = [
  "Europe/Kaliningrad",
  "Europe/Moscow",
  "Europe/Saratov",
  "Europe/Samara",
  "Asia/Yekaterinburg",
  "Asia/Omsk",
  "Asia/Krasnoyarsk",
  "Asia/Irkutsk",
  "Asia/Yakutsk",
  "Asia/Vladivostok",
  "Asia/Kamchatka",
  "UTC",
] as const;

const SELECT_CLASS = "min-h-11 w-full rounded-xs border border-line bg-surface px-3 text-base text-text focus:border-brand focus:outline-none focus-visible:ring-4 focus-visible:ring-brand/15 sm:text-[14px]";

function formatSavedAt(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" }).format(date);
}

function profileError(code?: string): string {
  switch (code) {
    case "bad_display_name": return "Укажи отображаемое имя.";
    case "bad_timezone": return "Выбери корректный часовой пояс.";
    case "bad_avatar": return "Фотография должна быть загружена в Аврору или доступна по HTTPS.";
    default: return "Не удалось сохранить профиль. Проверь соединение и повтори попытку.";
  }
}

export function AccountProfileSettings() {
  const uid = useId();
  const store = useStore();
  const { setPreference } = useAppTheme();
  const [saved, setSaved] = useState<AccountProfile | null>(null);
  const [draft, setDraft] = useState<AccountProfile | null>(null);
  const [savedAt, setSavedAt] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [editorFile, setEditorFile] = useState<File | null>(null);
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [reauthMethod, setReauthMethod] = useState<ReauthMethod>("unavailable");
  const [emailDraft, setEmailDraft] = useState("");
  const [emailPassword, setEmailPassword] = useState("");
  const [emailSaving, setEmailSaving] = useState(false);
  const [emailMessage, setEmailMessage] = useState("");
  const [pendingEmail, setPendingEmail] = useState<{ email: string; expiresAt: string } | null>(null);
  const [phoneDraft, setPhoneDraft] = useState("");
  const [phoneCode, setPhoneCode] = useState("");
  const [temporaryCode, setTemporaryCode] = useState("");
  const [pendingPhone, setPendingPhone] = useState<{ phone: string; expiresAt: string } | null>(null);
  const [phoneSaving, setPhoneSaving] = useState(false);
  const [phoneMessage, setPhoneMessage] = useState("");
  const [phoneVerificationState, setPhoneVerificationState] = useState<"temporary" | "unavailable">("unavailable");
  const emailRequestKey = useRef("");

  const dirty = Boolean(saved && draft && JSON.stringify(saved) !== JSON.stringify(draft));

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/settings/account-profile", { cache: "no-store" });
      const body = await response.json().catch(() => null) as ProfileResponse | null;
      if (!response.ok || !body?.ok || !body.profile) throw new Error(body?.requestId ?? "load_failed");
      setSaved(body.profile);
      setDraft(body.profile);
      setEmailDraft(body.profile.email);
      setPhoneDraft(body.profile.phone);
      setReauthMethod(body.reauthMethod ?? "unavailable");
      setPendingEmail(body.pendingEmail ?? null);
      setPendingPhone(body.pendingPhone ?? null);
      setPhoneVerificationState(body.phoneVerification?.state === "temporary" ? "temporary" : "unavailable");
      setSavedAt(body.savedAt ?? "");
      emailRequestKey.current = `email-change:${crypto.randomUUID()}`;
    } catch (loadError) {
      setError(`Не удалось загрузить профиль. Номер запроса: ${loadError instanceof Error ? loadError.message : "неизвестен"}`);
    } finally {
      setLoading(false);
    }
  }, []);

  /* eslint-disable react-hooks/set-state-in-effect -- первичная синхронизация формы с серверным профилем */
  useEffect(() => { void load(); }, [load]);
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const update = <K extends keyof AccountProfile>(key: K, value: AccountProfile[K]) => {
    setDraft((current) => current ? { ...current, [key]: value } : current);
    setMessage("");
    setError("");
  };

  const uploadEditedAvatar = async (blob: Blob) => {
    setAvatarUploading(true);
    try {
      const form = new FormData();
      form.set("avatar", new File([blob], "avatar.webp", { type: "image/webp" }));
      const response = await fetch("/api/settings/profile/avatar", { method: "POST", body: form });
      const body = await response.json().catch(() => null) as { ok?: boolean; avatar?: string; error?: string } | null;
      if (!response.ok || !body?.ok || !body.avatar) throw new Error("Не удалось загрузить отредактированную фотографию.");
      update("avatar", body.avatar);
      setEditorFile(null);
      setMessage("Фотография подготовлена. Нажми «Сохранить профиль». ");
    } finally {
      setAvatarUploading(false);
    }
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!draft || saving || avatarUploading) return;
    if (!draft.displayName.trim()) return setError("Укажи отображаемое имя.");
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/settings/account-profile", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          firstName: draft.firstName,
          lastName: draft.lastName,
          displayName: draft.displayName,
          jobTitle: draft.jobTitle,
          bio: draft.bio,
          avatar: draft.avatar,
          locale: draft.locale,
          timezone: draft.timezone,
          theme: draft.theme,
        }),
      });
      const body = await response.json().catch(() => null) as ProfileResponse | null;
      if (!response.ok || !body?.ok) throw new Error(profileError(body?.error));
      setSaved(draft);
      setSavedAt(body.savedAt ?? new Date().toISOString());
      setPreference(draft.theme);
      await store.refreshAuth();
      setMessage("Профиль сохранён.");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : profileError());
    } finally {
      setSaving(false);
    }
  };

  const requestEmail = async () => {
    if (!draft || emailSaving || emailDraft.trim().toLowerCase() === draft.email.toLowerCase()) return;
    if (reauthMethod !== "password") return setEmailMessage("Для изменения email сначала войди повторно через подключённый способ входа.");
    if (!emailPassword) return setEmailMessage("Введи текущий пароль.");
    setEmailSaving(true);
    setEmailMessage("");
    try {
      const requestKey = emailRequestKey.current || `email-change:${crypto.randomUUID()}`;
      const response = await fetch("/api/settings/profile/email/request", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": requestKey },
        body: JSON.stringify({ email: emailDraft, password: emailPassword, requestKey }),
      });
      const body = await response.json().catch(() => null) as { ok?: boolean; email?: string; expiresAt?: string; error?: string } | null;
      if (!response.ok || !body?.ok) throw new Error(body?.error === "reauth_failed" ? "Текущий пароль не подошёл." : "Не удалось отправить подтверждение.");
      setPendingEmail({ email: body.email ?? emailDraft.trim().toLowerCase(), expiresAt: body.expiresAt ?? "" });
      setEmailDraft(draft.email);
      setEmailPassword("");
      emailRequestKey.current = `email-change:${crypto.randomUUID()}`;
      setEmailMessage("Письмо отправлено. Адрес изменится после перехода по ссылке.");
    } catch (requestError) {
      setEmailMessage(requestError instanceof Error ? requestError.message : "Не удалось отправить подтверждение.");
    } finally {
      setEmailSaving(false);
    }
  };

  const requestPhone = async () => {
    if (phoneSaving || !phoneDraft.trim()) return;
    setPhoneSaving(true);
    setPhoneMessage("");
    try {
      const response = await fetch("/api/settings/account-profile/phone/request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone: phoneDraft }),
      });
      const body = await response.json().catch(() => null) as { ok?: boolean; phone?: string; expiresAt?: string; temporaryCode?: string; error?: string } | null;
      if (!response.ok || !body?.ok || !body.phone) throw new Error(body?.error === "bad_phone" ? "Проверь формат номера." : "Подтверждение телефона временно недоступно.");
      setPendingPhone({ phone: body.phone, expiresAt: body.expiresAt ?? "" });
      setTemporaryCode(body.temporaryCode ?? "");
      setPhoneCode("");
      setPhoneMessage("Код создан на 10 минут.");
    } catch (requestError) {
      setPhoneMessage(requestError instanceof Error ? requestError.message : "Не удалось создать код.");
    } finally {
      setPhoneSaving(false);
    }
  };

  const confirmPhone = async () => {
    if (phoneSaving || !/^[0-9]{6}$/u.test(phoneCode)) return setPhoneMessage("Введи шестизначный код.");
    setPhoneSaving(true);
    setPhoneMessage("");
    try {
      const response = await fetch("/api/settings/account-profile/phone/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: phoneCode }),
      });
      const body = await response.json().catch(() => null) as { ok?: boolean; phone?: string; error?: string } | null;
      if (!response.ok || !body?.ok || !body.phone) throw new Error(body?.error === "bad_code" ? "Код не подошёл." : "Не удалось подтвердить номер.");
      setDraft((current) => current ? { ...current, phone: body.phone ?? current.phone } : current);
      setSaved((current) => current ? { ...current, phone: body.phone ?? current.phone } : current);
      setPhoneDraft(body.phone);
      setPendingPhone(null);
      setTemporaryCode("");
      setPhoneCode("");
      setPhoneMessage("Телефон подтверждён.");
    } catch (confirmError) {
      setPhoneMessage(confirmError instanceof Error ? confirmError.message : "Не удалось подтвердить номер.");
    } finally {
      setPhoneSaving(false);
    }
  };

  if (loading) return <div className="skeleton h-[36rem] rounded-lg" role="status" aria-label="Загружаем профиль" />;
  if (!draft || !saved) {
    return <Card className="p-6" role="alert"><p className="font-bold text-text">Профиль не загрузился</p><p className="mt-1 text-[13px] text-text-3">{error}</p><Button className="mt-4" variant="outline" onClick={() => void load()}>Повторить</Button></Card>;
  }

  return (
    <>
      <Card as="section" className="overflow-hidden" data-settings-dirty={dirty ? "true" : "false"}>
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-5 sm:px-7">
          <div className="flex items-start gap-3">
            <span className="grid h-10 w-10 place-items-center rounded-sm bg-info-soft text-brand"><UserRound className="h-5 w-5" aria-hidden /></span>
            <div>
              <div className="flex flex-wrap items-center gap-2"><h2 className="text-[18px] font-extrabold text-text">Профиль</h2>{dirty ? <Badge tone="fire">Не сохранено</Badge> : null}</div>
              <p className="mt-1 text-[13px] text-text-3">Данные аккаунта и внешний вид внутри Авроры.</p>
            </div>
          </div>
          {savedAt ? <p className="flex items-center gap-1.5 text-[12px] text-text-3"><Clock3 className="h-3.5 w-3.5" aria-hidden />Сохранено в {formatSavedAt(savedAt)}</p> : null}
        </header>

        <form onSubmit={save} className="space-y-8 px-5 py-6 sm:px-7">
          <div className="grid gap-6 lg:grid-cols-[11rem_minmax(0,1fr)]">
            <div className="text-center lg:text-left">
              {draft.avatar ? (
                // eslint-disable-next-line @next/next/no-img-element -- authenticated user asset route
                <img src={draft.avatar} alt="Фотография профиля" className="mx-auto h-32 w-32 rounded-full object-cover shadow-soft ring-4 ring-surface-inset lg:mx-0" />
              ) : (
                <span className="mx-auto grid h-32 w-32 place-items-center rounded-full bg-surface-inset text-text-3 lg:mx-0"><UserRound className="h-12 w-12" aria-hidden /></span>
              )}
              <label className="mt-4 inline-flex min-h-10 cursor-pointer items-center gap-2 rounded-xs border border-line px-3 text-[13px] font-semibold text-text hover:border-brand/35 hover:text-brand">
                <ImagePlus className="h-4 w-4" aria-hidden />{draft.avatar ? "Заменить" : "Загрузить"}
                <input
                  type="file"
                  className="sr-only"
                  accept={PROFILE_AVATAR_ACCEPTED_TYPES.join(",")}
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0];
                    event.currentTarget.value = "";
                    if (!file) return;
                    if (!(PROFILE_AVATAR_ACCEPTED_TYPES as readonly string[]).includes(file.type)) return setError("Поддерживаются JPEG, PNG и WebP.");
                    if (file.size > PROFILE_AVATAR_UPLOAD_MAX_BYTES) return setError("Файл должен быть не больше 10 МБ.");
                    setEditorFile(file);
                  }}
                />
              </label>
              {draft.avatar ? <Button type="button" variant="ghost" size="sm" className="mt-2" onClick={() => update("avatar", "")}><Trash2 className="h-4 w-4" aria-hidden />Удалить</Button> : null}
              <p className="mt-2 text-[11px] leading-relaxed text-text-3">JPEG, PNG или WebP до 10 МБ.</p>
            </div>

            <div className="grid gap-5 sm:grid-cols-2">
              <Field label="Имя" htmlFor={`${uid}-first-name`}><Input id={`${uid}-first-name`} autoComplete="given-name" maxLength={80} value={draft.firstName} onChange={(event) => update("firstName", event.currentTarget.value)} /></Field>
              <Field label="Фамилия" htmlFor={`${uid}-last-name`}><Input id={`${uid}-last-name`} autoComplete="family-name" maxLength={80} value={draft.lastName} onChange={(event) => update("lastName", event.currentTarget.value)} /></Field>
              <Field label="Отображаемое имя" htmlFor={`${uid}-display-name`} required><Input id={`${uid}-display-name`} required maxLength={120} value={draft.displayName} onChange={(event) => update("displayName", event.currentTarget.value)} /></Field>
              <Field label="Должность" htmlFor={`${uid}-job-title`}><Input id={`${uid}-job-title`} maxLength={160} placeholder="Например: практикующий юрист" value={draft.jobTitle} onChange={(event) => update("jobTitle", event.currentTarget.value)} /></Field>
              <Field label="Краткое описание" htmlFor={`${uid}-bio`} hint="Видно только внутри профиля Авроры."><Textarea id={`${uid}-bio`} className="sm:col-span-2" rows={4} maxLength={1000} value={draft.bio} onChange={(event) => update("bio", event.currentTarget.value)} /></Field>
            </div>
          </div>

          <div className="grid gap-5 border-t border-line pt-7 sm:grid-cols-3">
            <Field label="Язык" htmlFor={`${uid}-locale`}><div className="relative"><Languages className="pointer-events-none absolute left-3 top-3.5 h-4 w-4 text-text-3" aria-hidden /><select id={`${uid}-locale`} className={`${SELECT_CLASS} pl-9`} value={draft.locale} onChange={(event) => update("locale", event.currentTarget.value as AccountProfile["locale"])}><option value="ru">Русский</option><option value="en">English</option></select></div></Field>
            <Field label="Часовой пояс" htmlFor={`${uid}-timezone`}><div className="relative"><Clock3 className="pointer-events-none absolute left-3 top-3.5 h-4 w-4 text-text-3" aria-hidden /><select id={`${uid}-timezone`} className={`${SELECT_CLASS} pl-9`} value={draft.timezone} onChange={(event) => update("timezone", event.currentTarget.value)}>{Array.from(new Set([draft.timezone, ...TIMEZONES])).map((zone) => <option key={zone} value={zone}>{zone}</option>)}</select></div></Field>
            <Field label="Тема" htmlFor={`${uid}-theme`}><select id={`${uid}-theme`} className={SELECT_CLASS} value={draft.theme} onChange={(event) => update("theme", event.currentTarget.value as AccountProfile["theme"])}><option value="system">Как в системе</option><option value="light">Светлая</option><option value="dark">Тёмная</option></select></Field>
          </div>

          <div className="grid gap-5 border-t border-line pt-7 lg:grid-cols-2">
            <div className="rounded-md bg-surface-inset p-4 sm:p-5">
              <h3 className="flex items-center gap-2 text-[15px] font-extrabold text-text"><AtSign className="h-4 w-4 text-brand" aria-hidden />Email</h3>
              <p className="mt-1 text-[12px] text-text-3">Текущий адрес: {draft.email || "не указан"}</p>
              <div className="mt-4 space-y-3">
                <Input type="email" value={emailDraft} onChange={(event) => setEmailDraft(event.currentTarget.value)} placeholder="new@example.ru" aria-label="Новый email" />
                {reauthMethod === "password" ? <Input type="password" value={emailPassword} onChange={(event) => setEmailPassword(event.currentTarget.value)} placeholder="Текущий пароль" aria-label="Текущий пароль" /> : null}
                <Button type="button" variant="outline" size="sm" loading={emailSaving} onClick={() => void requestEmail()}>Подтвердить новый email</Button>
                {pendingEmail ? <p className="text-[12px] text-info-text"><Check className="mr-1 inline h-3.5 w-3.5" aria-hidden />Ожидает подтверждения: {pendingEmail.email}</p> : null}
                {emailMessage ? <p className="text-[12px] text-text-2" aria-live="polite">{emailMessage}</p> : null}
              </div>
            </div>

            <div className="rounded-md bg-surface-inset p-4 sm:p-5">
              <h3 className="flex items-center gap-2 text-[15px] font-extrabold text-text"><Phone className="h-4 w-4 text-brand" aria-hidden />Телефон {phoneVerificationState === "temporary" ? <Badge tone="neutral">Временно</Badge> : null}</h3>
              {phoneVerificationState === "temporary" ? (
                <><p className="mt-1 text-[12px] text-text-3">Код подтверждения действует 10 минут.</p><div className="mt-4 space-y-3"><Input type="tel" value={phoneDraft} onChange={(event) => setPhoneDraft(event.currentTarget.value)} placeholder="+7 927 123-45-67" aria-label="Телефон" /><Button type="button" variant="outline" size="sm" loading={phoneSaving} onClick={() => void requestPhone()}>Получить код</Button>{pendingPhone ? <div className="space-y-2"><Input inputMode="numeric" maxLength={6} value={phoneCode} onChange={(event) => setPhoneCode(event.currentTarget.value.replace(/\D/gu, ""))} placeholder="6 цифр" aria-label="Код подтверждения телефона" />{temporaryCode ? <p className="rounded-xs bg-info-soft p-2 font-mono text-[12px] text-info-text">Временный код: {temporaryCode}</p> : null}<Button type="button" variant="soft" size="sm" onClick={() => void confirmPhone()} loading={phoneSaving}>Подтвердить телефон</Button></div> : null}{phoneMessage ? <p className="text-[12px] text-text-2" aria-live="polite">{phoneMessage}</p> : null}</div></>
              ) : <p className="mt-1 text-[12px] leading-relaxed text-text-3">Подтверждение телефона появится после подключения провайдера доставки кодов.</p>}
            </div>
          </div>

          {error ? <p role="alert" className="rounded-sm bg-danger-soft p-3 text-[13px] text-danger-text">{error}</p> : null}
          {message ? <p role="status" className="rounded-sm bg-success-soft p-3 text-[13px] text-success-text">{message}</p> : null}
          <div className="flex flex-col-reverse gap-2 border-t border-line pt-5 sm:flex-row sm:justify-end">
            <Button type="button" variant="ghost" disabled={!dirty || saving} onClick={() => { setDraft(saved); setMessage("Изменения отменены."); setError(""); }}><RotateCcw className="h-4 w-4" aria-hidden />Отменить изменения</Button>
            <Button type="submit" variant="brand" loading={saving} disabled={!dirty || avatarUploading}><Save className="h-4 w-4" aria-hidden />Сохранить профиль</Button>
          </div>
        </form>
      </Card>
      {editorFile ? <AvatarEditorDialog file={editorFile} onCancel={() => setEditorFile(null)} onApply={uploadEditedAvatar} /> : null}
    </>
  );
}
