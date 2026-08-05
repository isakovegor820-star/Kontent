"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AtSign, Check, Image as ImageIcon, Save, ShieldCheck, UserRound } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Badge, Card, Field, Input, Textarea } from "@/components/ui/primitives";
import { RUBRICS, type Brief } from "@/lib/brief";
import { PROFILE_FORMAT_OPTIONS } from "@/lib/profile";
import { useStore } from "@/lib/store";
import { NETWORK_LABEL, cn } from "@/lib/utils";

type ReauthMethod = "password" | "telegram" | "vk" | "unavailable";

type ProfileDraft = {
  name: string;
  avatar: string;
  niche: string;
  audience: string;
  goal: string;
  rubrics: string;
  formats: string;
  authorRole: string;
};

type ProfileResponse = {
  ok?: boolean;
  error?: string;
  requestId?: string;
  account?: { name: string; avatar: string; email: string; reauthMethod: ReauthMethod };
  pendingEmail?: { email: string; expiresAt: string } | null;
  channelId?: number | null;
  brief?: Brief | null;
  replayed?: boolean;
};

type PendingNavigation =
  | { kind: "channel"; channelId: number }
  | { kind: "link"; href: string }
  | null;

function newRequestKey(prefix: string): string {
  return `${prefix}:${globalThis.crypto.randomUUID()}`;
}

function listFromText(value: string): string[] {
  return [...new Set(value.split(/[,;\n]/u).map((item) => item.trim()).filter(Boolean))].slice(0, 10);
}

function textFromList(value: string[] | undefined): string {
  return value?.join(", ") ?? "";
}

function draftFrom(account: NonNullable<ProfileResponse["account"]>, brief: Brief): ProfileDraft {
  return {
    name: account.name,
    avatar: account.avatar,
    niche: brief.niche,
    audience: brief.audience,
    goal: brief.goal,
    rubrics: textFromList(brief.rubrics),
    formats: textFromList(brief.formats),
    authorRole: brief.authorRole,
  };
}

function requestError(code?: string): string {
  switch (code) {
    case "bad_name": return "Укажи имя или рабочее название профиля.";
    case "bad_avatar": return "Используй ссылку на аватар с защищённым адресом https://.";
    case "incomplete_brief": return "Заполни нишу и аудиторию — минимум по три символа.";
    case "channel_not_found": return "Канал отключён или больше недоступен. Выбери другой канал.";
    case "idempotency_conflict": return "Этот запрос уже использован для других данных. Обнови страницу и повтори сохранение.";
    default: return "Не удалось сохранить. Проверь соединение и повтори попытку.";
  }
}

function emailError(code?: string, provider?: string): string {
  switch (code) {
    case "reauth_failed": return "Текущий пароль не подошёл. Проверь его и повтори попытку.";
    case "reauth_required": return `Сначала повторно войди через ${provider === "telegram" ? "Telegram" : provider === "vk" ? "VK" : "провайдера"}, затем запроси смену email.`;
    case "email_taken": return "Этот email уже привязан к другому аккаунту.";
    case "email_delivery_unavailable": return "Отправка подтверждений временно недоступна. Текущий email не изменён.";
    case "idempotency_conflict": return "Адрес изменился после отправки запроса. Повтори действие.";
    default: return "Не удалось отправить письмо. Проверь соединение и повтори попытку.";
  }
}

export function ProfileBriefSection() {
  const store = useStore();
  const router = useRouter();
  const uid = useId();
  const channels = useMemo(
    () => store.realChannels.filter((channel) => channel.is_active),
    [store.realChannels],
  );
  const [channelId, setChannelId] = useState<number | null>(null);
  const [saved, setSaved] = useState<ProfileDraft | null>(null);
  const [draft, setDraft] = useState<ProfileDraft | null>(null);
  const [email, setEmail] = useState("");
  const [emailDraft, setEmailDraft] = useState("");
  const [emailPassword, setEmailPassword] = useState("");
  const [reauthMethod, setReauthMethod] = useState<ReauthMethod>("unavailable");
  const [pendingEmail, setPendingEmail] = useState<{ email: string; expiresAt: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [emailSaving, setEmailSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [emailMessage, setEmailMessage] = useState("");
  const [emailErrorText, setEmailErrorText] = useState("");
  const [pendingNavigation, setPendingNavigation] = useState<PendingNavigation>(null);
  const [avatarBroken, setAvatarBroken] = useState(false);
  const profileKey = useRef("");
  const emailKey = useRef("");

  const profileDirty = Boolean(saved && draft && JSON.stringify(saved) !== JSON.stringify(draft));
  const emailDirty = emailDraft.trim().toLowerCase() !== email.trim().toLowerCase();
  const dirty = profileDirty || emailDirty;

  /* eslint-disable react-hooks/set-state-in-effect -- select the first available persisted channel */
  useEffect(() => {
    if (channelId && channels.some((channel) => channel.id === channelId)) return;
    setChannelId(channels[0]?.id ?? null);
  }, [channelId, channels]);
  /* eslint-enable react-hooks/set-state-in-effect */

  /* eslint-disable react-hooks/set-state-in-effect -- load the authoritative server profile when channel changes */
  useEffect(() => {
    if (!channelId) {
      setSaved(null);
      setDraft(null);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setMessage("");
    fetch(`/api/settings/profile?channel=${channelId}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const body = (await response.json().catch(() => null)) as ProfileResponse | null;
        if (!response.ok || !body?.ok || !body.account || !body.brief || !body.channelId) {
          throw new Error(body?.requestId || "load_failed");
        }
        const next = draftFrom(body.account, body.brief);
        setChannelId(body.channelId);
        setSaved(next);
        setDraft(next);
        setEmail(body.account.email);
        setEmailDraft(body.account.email);
        setReauthMethod(body.account.reauthMethod);
        setPendingEmail(body.pendingEmail ?? null);
        setEmailPassword("");
        setEmailErrorText("");
        profileKey.current = newRequestKey("profile-save");
        emailKey.current = newRequestKey("email-change");
      })
      .catch((loadError) => {
        if ((loadError as Error).name !== "AbortError") {
          setError(`Не удалось загрузить профиль. ID запроса: ${(loadError as Error).message}`);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [channelId]);
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    const interceptLink = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (!target || target.target === "_blank" || target.hasAttribute("download")) return;
      const url = new URL(target.href, window.location.href);
      if (url.origin !== window.location.origin || url.href === window.location.href) return;
      event.preventDefault();
      setPendingNavigation({ kind: "link", href: `${url.pathname}${url.search}${url.hash}` });
    };
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", interceptLink, true);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", interceptLink, true);
    };
  }, [dirty]);

  const update = <K extends keyof ProfileDraft>(key: K, value: ProfileDraft[K]) => {
    setDraft((current) => current ? { ...current, [key]: value } : current);
    setMessage("");
    setError("");
    if (key === "avatar") setAvatarBroken(false);
  };

  const toggleListValue = (key: "rubrics" | "formats", value: string) => {
    if (!draft) return;
    const list = listFromText(draft[key]);
    const next = list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
    update(key, textFromList(next));
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!draft || !channelId || saving) return;
    if (!profileDirty) {
      setMessage("Изменений для сохранения нет.");
      return;
    }
    if (!draft.name.trim()) return setError("Укажи имя или рабочее название профиля.");
    if (draft.niche.trim().length < 3 || draft.audience.trim().length < 3) {
      return setError("Заполни нишу и аудиторию — минимум по три символа.");
    }
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const requestKey = profileKey.current || newRequestKey("profile-save");
      profileKey.current = requestKey;
      const response = await fetch("/api/settings/profile", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": requestKey },
        body: JSON.stringify({
          requestKey,
          channelId,
          name: draft.name,
          avatar: draft.avatar,
          brief: {
            niche: draft.niche,
            audience: draft.audience,
            goal: draft.goal,
            rubrics: listFromText(draft.rubrics),
            formats: listFromText(draft.formats),
            authorRole: draft.authorRole,
          },
        }),
      });
      const body = (await response.json().catch(() => null)) as ProfileResponse | null;
      if (!response.ok || !body?.ok) {
        throw new Error(`${requestError(body?.error)}${body?.requestId ? ` ID запроса: ${body.requestId}` : ""}`);
      }
      setSaved(draft);
      profileKey.current = newRequestKey("profile-save");
      setMessage(body.replayed ? "Изменения уже были сохранены." : "Профиль и исходный бриф сохранены.");
      await store.refreshAuth();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : requestError());
    } finally {
      setSaving(false);
    }
  };

  const requestEmailChange = async () => {
    if (!emailDirty || emailSaving) return;
    if (reauthMethod !== "password") {
      setEmailErrorText(emailError("reauth_required", reauthMethod));
      return;
    }
    if (!emailPassword) {
      setEmailErrorText("Введи текущий пароль, чтобы подтвердить изменение email.");
      return;
    }
    setEmailSaving(true);
    setEmailErrorText("");
    setEmailMessage("");
    try {
      const requestKey = emailKey.current || newRequestKey("email-change");
      emailKey.current = requestKey;
      const response = await fetch("/api/settings/profile/email/request", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": requestKey },
        body: JSON.stringify({ email: emailDraft, password: emailPassword, requestKey }),
      });
      const body = (await response.json().catch(() => null)) as
        | { ok?: boolean; error?: string; reauthProvider?: string; requestId?: string; expiresAt?: string; email?: string }
        | null;
      if (!response.ok || !body?.ok) {
        throw new Error(`${emailError(body?.error, body?.reauthProvider)}${body?.requestId ? ` ID запроса: ${body.requestId}` : ""}`);
      }
      const target = body.email ?? emailDraft.trim().toLowerCase();
      setPendingEmail({ email: target, expiresAt: body.expiresAt ?? new Date(Date.now() + 3_600_000).toISOString() });
      setEmailDraft(email);
      setEmailPassword("");
      emailKey.current = newRequestKey("email-change");
      setEmailMessage(`Письмо отправлено на ${target}. Email изменится только после подтверждения.`);
    } catch (requestErrorValue) {
      setEmailErrorText(requestErrorValue instanceof Error ? requestErrorValue.message : emailError());
    } finally {
      setEmailSaving(false);
    }
  };

  const chooseChannel = (next: number) => {
    if (next === channelId) return;
    if (dirty) setPendingNavigation({ kind: "channel", channelId: next });
    else setChannelId(next);
  };

  const discardAndContinue = () => {
    const pending = pendingNavigation;
    setPendingNavigation(null);
    if (!pending) return;
    if (pending.kind === "channel") setChannelId(pending.channelId);
    else router.push(pending.href);
  };

  const activeFormats = draft ? listFromText(draft.formats) : [];
  const activeRubrics = draft ? listFromText(draft.rubrics) : [];

  return (
    <>
      <Card as="section" className="mb-5 overflow-hidden" aria-busy={loading || saving || emailSaving || undefined}>
        <div className="flex items-start gap-3.5 border-b border-line px-5 py-5 sm:px-7">
          <span aria-hidden className="grid h-10 w-10 shrink-0 place-items-center rounded-sm bg-info-soft text-brand">
            <UserRound className="h-5 w-5" strokeWidth={1.75} />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-[17px] font-extrabold tracking-tight text-text">Профиль и исходный бриф</h2>
              {dirty && <Badge tone="fire">Есть несохранённые изменения</Badge>}
            </div>
            <p className="mt-1 max-w-3xl text-[14px] leading-relaxed text-text-2">
              Личные данные относятся к аккаунту, а ответы о нише и аудитории сохраняются в существующем профиле выбранного канала.
            </p>
          </div>
        </div>

        {channels.length === 0 ? (
          <div className="px-5 py-6 sm:px-7">
            <p className="text-[14px] font-semibold text-text">Сначала подключи канал</p>
            <p className="mt-1 text-[13px] leading-relaxed text-text-3">После подключения здесь появится его исходный бриф.</p>
          </div>
        ) : loading && !draft ? (
          <div role="status" className="space-y-3 px-5 py-6 sm:px-7">
            <span className="sr-only">Загружаем профиль</span>
            <div className="skeleton h-12 w-full rounded-sm" />
            <div className="grid gap-3 sm:grid-cols-2"><div className="skeleton h-12 rounded-sm" /><div className="skeleton h-12 rounded-sm" /></div>
          </div>
        ) : draft ? (
          <form onSubmit={save} className="space-y-8 px-5 py-6 sm:px-7 sm:py-7">
            <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(16rem,0.72fr)]">
              <div className="space-y-5">
                <div>
                  <h3 className="text-[15px] font-extrabold text-text">Аккаунт</h3>
                  <p className="mt-1 text-[12px] leading-relaxed text-text-3">Имя и аватар видны во всех каналах.</p>
                </div>
                <Field label="Имя" htmlFor={`${uid}-name`} required>
                  <Input id={`${uid}-name`} name="name" autoComplete="name" value={draft.name} onChange={(event) => update("name", event.target.value)} />
                </Field>
                <Field label="Ссылка на аватар" htmlFor={`${uid}-avatar`} hint="Только защищённая ссылка https://. Оставь поле пустым, чтобы убрать аватар.">
                  <Input id={`${uid}-avatar`} name="avatar" type="url" inputMode="url" autoComplete="photo" placeholder="https://example.com/avatar.jpg" value={draft.avatar} onChange={(event) => update("avatar", event.target.value)} />
                </Field>
              </div>

              <div className="rounded-md bg-surface-inset p-4 sm:p-5">
                <div className="flex items-center gap-2 text-[13px] font-bold text-text-2">
                  <ImageIcon className="h-4 w-4" aria-hidden />
                  Предпросмотр аватара
                </div>
                <div className="mt-4 flex items-center gap-4">
                  {draft.avatar && !avatarBroken ? (
                    // eslint-disable-next-line @next/next/no-img-element -- user-controlled remote avatar is not proxied server-side
                    <img
                      src={draft.avatar}
                      alt="Предпросмотр аватара профиля"
                      className="h-20 w-20 shrink-0 rounded-full object-cover outline outline-1 outline-black/10"
                      onError={() => setAvatarBroken(true)}
                    />
                  ) : (
                    <span aria-hidden className="grid h-20 w-20 shrink-0 place-items-center rounded-full bg-surface text-text-3 shadow-soft">
                      <UserRound className="h-8 w-8" strokeWidth={1.5} />
                    </span>
                  )}
                  <p className="min-w-0 text-[13px] leading-relaxed text-text-3">
                    {avatarBroken ? "Изображение не загрузилось. Проверь ссылку." : draft.avatar ? "Так аватар будет выглядеть в профиле." : "Можно сохранить профиль без аватара."}
                  </p>
                </div>
              </div>
            </div>

            <div className="space-y-5">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <h3 className="text-[15px] font-extrabold text-text">Исходный бриф канала</h3>
                  <p className="mt-1 text-[12px] leading-relaxed text-text-3">Аврора использует эти ответы в генерации и планировании.</p>
                </div>
                <label className="min-w-0 sm:min-w-72">
                  <span className="mb-2 block text-[12px] font-semibold text-text-2">Канал</span>
                  <select
                    value={channelId ?? ""}
                    onChange={(event) => chooseChannel(Number(event.target.value))}
                    className="h-11 w-full rounded-xs border border-line bg-surface px-3 text-[14px] font-semibold text-text focus:border-brand focus:outline-none focus-visible:ring-4 focus-visible:ring-brand/15"
                  >
                    {channels.map((channel) => (
                      <option key={channel.id} value={channel.id}>
                        {channel.title || channel.handle || `Канал #${channel.id}`} · {NETWORK_LABEL[channel.network] ?? channel.network}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <div className="grid gap-5 sm:grid-cols-2">
                <Field label="Ниша" htmlFor={`${uid}-niche`} required hint="О чём канал и в какой предметной области ты работаешь.">
                  <Textarea id={`${uid}-niche`} rows={3} value={draft.niche} onChange={(event) => update("niche", event.target.value)} placeholder="Например: юридическая безопасность малого бизнеса" />
                </Field>
                <Field label="Аудитория" htmlFor={`${uid}-audience`} required hint="Роль, контекст и главная потребность читателей.">
                  <Textarea id={`${uid}-audience`} rows={3} value={draft.audience} onChange={(event) => update("audience", event.target.value)} placeholder="Например: владельцы компаний без штатного юриста" />
                </Field>
                <Field label="Цель" htmlFor={`${uid}-goal`} hint="Какой результат должен поддерживать контент.">
                  <Textarea id={`${uid}-goal`} rows={3} value={draft.goal} onChange={(event) => update("goal", event.target.value)} placeholder="Например: приводить заявки на первичную консультацию" />
                </Field>
                <Field label="Роль автора" htmlFor={`${uid}-author-role`} hint="От чьего лица и с какой экспертизой пишет автор.">
                  <Textarea id={`${uid}-author-role`} rows={3} value={draft.authorRole} onChange={(event) => update("authorRole", event.target.value)} placeholder="Например: управляющий партнёр юридической фирмы" />
                </Field>
              </div>

              <Field label="Рубрики" htmlFor={`${uid}-rubrics`} hint="Разделяй названия запятыми. Можно выбрать готовые варианты и добавить свои.">
                <Input id={`${uid}-rubrics`} value={draft.rubrics} onChange={(event) => update("rubrics", event.target.value)} placeholder="Практика, разборы, ответы на вопросы" />
              </Field>
              <div className="flex flex-wrap gap-2" aria-label="Готовые рубрики">
                {RUBRICS.map((rubric) => {
                  const active = activeRubrics.includes(rubric.label);
                  return (
                    <button
                      key={rubric.key}
                      type="button"
                      aria-pressed={active}
                      onClick={() => toggleListValue("rubrics", rubric.label)}
                      className={cn(
                        "min-h-11 rounded-full border px-3 py-2 text-[13px] font-semibold transition-[border-color,background-color,color]",
                        active ? "border-brand bg-info-soft text-info-text" : "border-line bg-surface text-text-2 hover:border-brand/35",
                      )}
                    >
                      {rubric.emoji} {rubric.label}
                    </button>
                  );
                })}
              </div>

              <Field label="Форматы" htmlFor={`${uid}-formats`} hint="Формат подачи хранится отдельно от смысловой рубрики.">
                <Input id={`${uid}-formats`} value={draft.formats} onChange={(event) => update("formats", event.target.value)} placeholder="Текст, фото, короткое видео" />
              </Field>
              <div className="flex flex-wrap gap-2" aria-label="Готовые форматы">
                {PROFILE_FORMAT_OPTIONS.map((format) => {
                  const active = activeFormats.includes(format);
                  return (
                    <button
                      key={format}
                      type="button"
                      aria-pressed={active}
                      onClick={() => toggleListValue("formats", format)}
                      className={cn(
                        "min-h-11 rounded-full border px-3 py-2 text-[13px] font-semibold transition-[border-color,background-color,color]",
                        active ? "border-brand bg-info-soft text-info-text" : "border-line bg-surface text-text-2 hover:border-brand/35",
                      )}
                    >
                      {active && <Check className="mr-1 inline h-3.5 w-3.5" aria-hidden />}
                      {format}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="rounded-md bg-surface-inset p-4 sm:p-5">
              <div className="flex items-start gap-3">
                <AtSign className="mt-0.5 h-5 w-5 shrink-0 text-brand" aria-hidden />
                <div className="min-w-0 flex-1">
                  <h3 className="text-[15px] font-extrabold text-text">Email</h3>
                  <p className="mt-1 text-[12px] leading-relaxed text-text-3">Новый адрес сохранится только после повторной проверки личности и перехода по одноразовой ссылке.</p>
                </div>
              </div>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <Field label="Email" htmlFor={`${uid}-email`}>
                  <Input
                    id={`${uid}-email`}
                    name="email"
                    type="email"
                    inputMode="email"
                    autoComplete="email"
                    value={emailDraft}
                    onChange={(event) => {
                      setEmailDraft(event.target.value);
                      setEmailErrorText("");
                      setEmailMessage("");
                      emailKey.current = newRequestKey("email-change");
                    }}
                  />
                </Field>
                {emailDirty && reauthMethod === "password" && (
                  <Field label="Текущий пароль" htmlFor={`${uid}-current-password`}>
                    <Input id={`${uid}-current-password`} type="password" autoComplete="current-password" value={emailPassword} onChange={(event) => setEmailPassword(event.target.value)} />
                  </Field>
                )}
              </div>
              {emailDirty && reauthMethod !== "password" && (
                <p className="mt-3 rounded-sm bg-fire-soft p-3 text-[13px] leading-relaxed text-fire-text">
                  Для смены email нужна свежая повторная авторизация через {reauthMethod === "telegram" ? "Telegram" : reauthMethod === "vk" ? "VK" : "провайдера"}. Текущий сеанс не считается таким подтверждением.
                </p>
              )}
              {pendingEmail && (
                <p className="mt-3 flex items-start gap-2 rounded-sm bg-info-soft p-3 text-[13px] leading-relaxed text-info-text">
                  <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                  Ожидаем подтверждение адреса {pendingEmail.email}. Ссылка действует до {new Date(pendingEmail.expiresAt).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" })}.
                </p>
              )}
              {emailDirty && reauthMethod === "password" && (
                <Button type="button" variant="outline" className="mt-4" loading={emailSaving} onClick={requestEmailChange}>
                  <AtSign className="h-4 w-4" aria-hidden />
                  Отправить подтверждение
                </Button>
              )}
              <div className="mt-3 min-h-5" aria-live="polite">
                {emailErrorText ? <p role="alert" className="text-[13px] font-medium text-danger-text">{emailErrorText}</p> : emailMessage ? <p role="status" className="text-[13px] font-medium text-success-text">{emailMessage}</p> : null}
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-h-5" aria-live="polite">
                {error ? <p role="alert" className="max-w-2xl text-[13px] font-medium text-danger-text">{error}</p> : message ? <p role="status" className="text-[13px] font-medium text-success-text">{message}</p> : null}
              </div>
              <Button type="submit" variant="brand" loading={saving}>
                <Save className="h-4 w-4" aria-hidden />
                Сохранить профиль
              </Button>
            </div>
          </form>
        ) : (
          <div className="px-5 py-6 sm:px-7">
            <p role="alert" className="text-[14px] text-danger-text">{error || "Профиль недоступен."}</p>
          </div>
        )}
      </Card>

      <ConfirmDialog
        open={pendingNavigation != null}
        title="Отменить несохранённые изменения?"
        description="Изменения профиля и исходного брифа будут потеряны."
        confirmLabel="Отменить изменения"
        onConfirm={discardAndContinue}
        onCancel={() => setPendingNavigation(null)}
      />
    </>
  );
}
