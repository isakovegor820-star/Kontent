"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Bell,
  Check,
  LogOut,
  Mail,
  RotateCcw,
  Save,
  ShieldCheck,
  Smartphone,
} from "lucide-react";

import { Button, buttonClassName } from "@/components/ui/button";
import { Badge, Card } from "@/components/ui/primitives";
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_EVENTS,
  type NotificationChannel,
  type NotificationEvent,
  type NotificationPreferences,
} from "@/lib/account-settings";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";

const EVENT_COPY: Record<NotificationEvent, { label: string; description: string }> = {
  publication_ready: { label: "Публикация готова", description: "Материал ожидает твоей проверки." },
  publication_result: { label: "Результат публикации", description: "Успешная отправка или подтверждённая ошибка." },
  autopilot_plan: { label: "План автопилота", description: "Новый недельный план готов к просмотру." },
  limit_warning: { label: "Лимиты", description: "Основной или тестовый лимит подходит к концу." },
  integration_problem: { label: "Проблемы интеграций", description: "Канал или подключение требует внимания." },
  security: { label: "Безопасность", description: "Изменение email, телефона или вход в аккаунт." },
};

const CHANNEL_COPY: Record<NotificationChannel, { label: string; icon: React.ReactNode }> = {
  inApp: { label: "В Авроре", icon: <Bell className="h-4 w-4" aria-hidden /> },
  email: { label: "Email", icon: <Mail className="h-4 w-4" aria-hidden /> },
  telegram: { label: "Telegram", icon: <Smartphone className="h-4 w-4" aria-hidden /> },
};

export function NotificationSecuritySettings() {
  const store = useStore();
  const [saved, setSaved] = useState<NotificationPreferences | null>(null);
  const [draft, setDraft] = useState<NotificationPreferences | null>(null);
  const [availability, setAvailability] = useState<Record<NotificationChannel, boolean>>({ inApp: true, email: false, telegram: false });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [savedAt, setSavedAt] = useState("");
  const dirty = Boolean(saved && draft && JSON.stringify(saved) !== JSON.stringify(draft));

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/settings/notifications", { cache: "no-store" });
      const body = await response.json().catch(() => null) as {
        ok?: boolean;
        preferences?: NotificationPreferences;
        availability?: Record<NotificationChannel, boolean>;
      } | null;
      if (!response.ok || !body?.ok || !body.preferences) throw new Error("load_failed");
      setSaved(body.preferences);
      setDraft(body.preferences);
      setAvailability(body.availability ?? { inApp: true, email: false, telegram: false });
    } catch {
      setError("Не удалось загрузить уведомления.");
    } finally {
      setLoading(false);
    }
  }, []);

  /* eslint-disable react-hooks/set-state-in-effect -- первичная синхронизация формы с серверными настройками */
  useEffect(() => { void load(); }, [load]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const toggle = (event: NotificationEvent, channel: NotificationChannel) => {
    setDraft((current) => current ? {
      ...current,
      [event]: { ...current[event], [channel]: !current[event][channel] },
    } : current);
    setMessage("");
  };

  const save = async () => {
    if (!draft || saving || !dirty) return;
    setSaving(true);
    setError("");
    try {
      const response = await fetch("/api/settings/notifications", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ preferences: draft }),
      });
      const body = await response.json().catch(() => null) as { ok?: boolean; savedAt?: string } | null;
      if (!response.ok || !body?.ok) throw new Error("save_failed");
      setSaved(draft);
      setSavedAt(body.savedAt ?? new Date().toISOString());
      setMessage("Настройки уведомлений сохранены.");
    } catch {
      setError("Не удалось сохранить уведомления.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5" data-settings-dirty={dirty ? "true" : "false"}>
      <Card as="section" className="overflow-hidden">
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-5 sm:px-7">
          <div className="flex items-start gap-3">
            <span className="grid h-10 w-10 place-items-center rounded-sm bg-info-soft text-brand"><Bell className="h-5 w-5" aria-hidden /></span>
            <div><div className="flex flex-wrap items-center gap-2"><h2 className="text-[18px] font-extrabold text-text">Уведомления</h2>{dirty ? <Badge tone="fire">Не сохранено</Badge> : null}</div><p className="mt-1 text-[13px] text-text-3">Выбери события и удобный способ доставки.</p></div>
          </div>
          {savedAt ? <p className="text-[12px] text-text-3">Сохранено в {new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" }).format(new Date(savedAt))}</p> : null}
        </header>

        <div className="px-3 py-4 sm:px-7 sm:py-6">
          {loading ? <div className="skeleton h-72 rounded-md" /> : !draft ? <p role="alert" className="rounded-sm bg-danger-soft p-4 text-[13px] text-danger-text">{error || "Настройки недоступны."}</p> : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[42rem] border-separate border-spacing-0 text-left">
                  <thead><tr><th className="border-b border-line px-3 py-3 text-[12px] font-bold uppercase tracking-wide text-text-3">Событие</th>{NOTIFICATION_CHANNELS.map((channel) => <th key={channel} className="border-b border-line px-3 py-3 text-center text-[12px] font-bold text-text-2"><span className="inline-flex items-center gap-1.5">{CHANNEL_COPY[channel].icon}{CHANNEL_COPY[channel].label}</span></th>)}</tr></thead>
                  <tbody>{NOTIFICATION_EVENTS.map((event) => <tr key={event}><td className="border-b border-line px-3 py-4"><p className="text-[13px] font-bold text-text">{EVENT_COPY[event].label}</p><p className="mt-0.5 text-[11px] text-text-3">{EVENT_COPY[event].description}</p></td>{NOTIFICATION_CHANNELS.map((channel) => { const disabled = !availability[channel]; const checked = draft[event][channel]; return <td key={channel} className="border-b border-line px-3 py-4 text-center"><button type="button" disabled={disabled} aria-label={`${EVENT_COPY[event].label}: ${CHANNEL_COPY[channel].label}`} aria-pressed={checked} onClick={() => toggle(event, channel)} className={cn("mx-auto grid h-8 w-8 place-items-center rounded-xs border transition-colors", checked ? "border-brand bg-brand text-white" : "border-line bg-surface text-transparent", disabled && "cursor-not-allowed opacity-35")}><Check className="h-4 w-4" aria-hidden /></button></td>; })}</tr>)}</tbody>
                </table>
              </div>
              {!availability.telegram ? <p className="mt-4 rounded-sm bg-info-soft p-3 text-[12px] text-info-text">Подключи Telegram в разделе «Интеграции», чтобы получать сообщения в боте.</p> : null}
              {error ? <p role="alert" className="mt-4 text-[13px] text-danger-text">{error}</p> : null}
              {message ? <p role="status" className="mt-4 text-[13px] text-success-text">{message}</p> : null}
              <div className="mt-5 flex flex-col-reverse gap-2 border-t border-line pt-5 sm:flex-row sm:justify-end">
                <Button type="button" variant="ghost" disabled={!dirty || saving} onClick={() => { setDraft(saved ?? DEFAULT_NOTIFICATION_PREFERENCES); setMessage("Изменения отменены."); }}><RotateCcw className="h-4 w-4" aria-hidden />Отменить изменения</Button>
                <Button type="button" variant="brand" loading={saving} disabled={!dirty} onClick={() => void save()}><Save className="h-4 w-4" aria-hidden />Сохранить уведомления</Button>
              </div>
            </>
          )}
        </div>
      </Card>

      <Card as="section" className="overflow-hidden">
        <header className="flex items-start gap-3 border-b border-line px-5 py-5 sm:px-7"><span className="grid h-10 w-10 place-items-center rounded-sm bg-info-soft text-brand"><ShieldCheck className="h-5 w-5" aria-hidden /></span><div><h2 className="text-[18px] font-extrabold text-text">Безопасность</h2><p className="mt-1 text-[13px] text-text-3">Пароль и текущая сессия аккаунта.</p></div></header>
        <div className="flex flex-col gap-4 px-5 py-6 sm:flex-row sm:items-center sm:justify-between sm:px-7">
          <div><p className="text-[14px] font-bold text-text">Смена пароля</p><p className="mt-1 text-[12px] text-text-3">Новый пароль устанавливается после проверки email.</p></div>
          <Link href="/forgot-password" className={buttonClassName({ variant: "outline" })}>Сменить пароль</Link>
        </div>
        <div className="flex flex-col gap-4 border-t border-line px-5 py-6 sm:flex-row sm:items-center sm:justify-between sm:px-7">
          <div><p className="text-[14px] font-bold text-text">Выйти из аккаунта</p><p className="mt-1 text-[12px] text-text-3">Текущая сессия на этом устройстве будет завершена.</p></div>
          <Button variant="danger" onClick={() => store.signOut()}><LogOut className="h-4 w-4" aria-hidden />Выйти</Button>
        </div>
      </Card>
    </div>
  );
}
