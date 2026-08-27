"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ArrowRightLeft,
  Check,
  CircleHelp,
  Copy,
  FolderKanban,
  Play,
  RotateCcw,
  Save,
  Sparkles,
} from "lucide-react";

import { channelName } from "@/components/app/channel-picker";
import { useProjects } from "@/components/app/project-provider";
import { Button } from "@/components/ui/button";
import { Badge, Card, Field, Input } from "@/components/ui/primitives";
import {
  CHANNEL_COPY_GROUPS,
  mergeChannelConfiguration,
  type ChannelConfigurationForCopy,
  type ChannelCopyGroup,
} from "@/lib/channel-settings-copy";
import type { AppliedSettingReport } from "@/lib/settings-preview";
import { useStore } from "@/lib/store";
import { NETWORK_LABEL, cn } from "@/lib/utils";

const TIMEZONES = ["Europe/Moscow", "Europe/Saratov", "Europe/Samara", "Asia/Yekaterinburg", "UTC"];
const SELECT_CLASS = "min-h-11 w-full rounded-xs border border-line bg-surface px-3 text-base text-text focus:border-brand focus:outline-none focus-visible:ring-4 focus-visible:ring-brand/15 sm:text-[14px]";

export function ProjectBasicsSection() {
  const projects = useProjects();
  const current = projects.current;
  const [saved, setSaved] = useState({ name: "", timezone: "" });
  const [draft, setDraft] = useState({ name: "", timezone: "" });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const dirty = JSON.stringify(saved) !== JSON.stringify(draft);

  /* eslint-disable react-hooks/set-state-in-effect -- выбранный проект может смениться из общего переключателя */
  useEffect(() => {
    if (!current) return;
    const value = { name: current.name, timezone: current.timezone };
    setSaved(value);
    setDraft(value);
  }, [current]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const save = async () => {
    if (!dirty || saving || !current) return;
    setSaving(true);
    setError("");
    try {
      const response = await fetch("/api/projects/current", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(draft),
      });
      const body = await response.json().catch(() => null) as { ok?: boolean; error?: string } | null;
      if (!response.ok || !body?.ok) throw new Error(body?.error === "access_denied" ? "Недостаточно прав для изменения проекта." : "Не удалось сохранить проект.");
      setSaved(draft);
      await projects.refresh();
      setMessage("Проект сохранён.");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Не удалось сохранить проект.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card as="section" className="overflow-hidden" data-settings-dirty={dirty ? "true" : "false"}>
      <header className="flex items-start gap-3 border-b border-line px-5 py-5 sm:px-7"><span className="grid h-10 w-10 place-items-center rounded-sm bg-info-soft text-brand"><FolderKanban className="h-5 w-5" aria-hidden /></span><div><div className="flex flex-wrap items-center gap-2"><h2 className="text-[18px] font-extrabold text-text">Проект</h2>{dirty ? <Badge tone="fire">Не сохранено</Badge> : null}</div><p className="mt-1 text-[13px] text-text-3">Название и часовой пояс действуют для всех каналов проекта.</p></div></header>
      {!projects.ready ? <div className="m-6 skeleton h-44 rounded-md" /> : !current ? <p className="p-6 text-[14px] text-text-2">Проект не выбран.</p> : (
        <div className="space-y-6 px-5 py-6 sm:px-7">
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Название проекта" htmlFor="project-settings-name" required><Input id="project-settings-name" required maxLength={160} value={draft.name} onChange={(event) => { const name = event.currentTarget.value; setDraft((value) => ({ ...value, name })); }} /></Field>
            <Field label="Часовой пояс проекта" htmlFor="project-settings-timezone"><select id="project-settings-timezone" className={SELECT_CLASS} value={draft.timezone} onChange={(event) => { const timezone = event.currentTarget.value; setDraft((value) => ({ ...value, timezone })); }}>{Array.from(new Set([draft.timezone, ...TIMEZONES])).map((zone) => <option key={zone} value={zone}>{zone}</option>)}</select></Field>
          </div>
          <p className="rounded-sm bg-surface-inset p-3 text-[12px] text-text-3">Текущий проект: {current.personal ? "личный" : "рабочий"}. Канальные настройки и словарь бренда сохраняются отдельно.</p>
          {error ? <p role="alert" className="text-[13px] text-danger-text">{error}</p> : null}{message ? <p role="status" className="text-[13px] text-success-text">{message}</p> : null}
          <div className="flex flex-col-reverse gap-2 border-t border-line pt-5 sm:flex-row sm:justify-end"><Button variant="ghost" disabled={!dirty || saving} onClick={() => { setDraft(saved); setMessage("Изменения отменены."); }}><RotateCcw className="h-4 w-4" aria-hidden />Отменить изменения</Button><Button variant="brand" loading={saving} disabled={!dirty} onClick={() => void save()}><Save className="h-4 w-4" aria-hidden />Сохранить проект</Button></div>
        </div>
      )}
    </Card>
  );
}

const COPY_LABELS: Record<ChannelCopyGroup, { label: string; description: string }> = {
  channel: { label: "Канал и аудитория", description: "Ниша, аудитория, цель, рубрики и форматы." },
  author: { label: "Образ и экспертиза автора", description: "Ответы подробной анкеты автора." },
  voice: { label: "Голос и стиль", description: "Тон, обращение, энергия, юмор и примеры." },
  structure: { label: "Структура", description: "Объём, хук, абзацы, списки и цитаты." },
  constraints: { label: "Ограничения", description: "Факты, стоп-темы, CTA, эмодзи и качество." },
  autopilot: { label: "Автопилот", description: "Ритм и параметры плана; запуск останется выключен." },
};

export function ChannelCopySection() {
  const store = useStore();
  const channels = store.realChannels.filter((channel) => channel.is_active);
  const [sourceId, setSourceId] = useState<number | null>(null);
  const [targetId, setTargetId] = useState<number | null>(null);
  const [groups, setGroups] = useState<Set<ChannelCopyGroup>>(new Set(CHANNEL_COPY_GROUPS));
  const [copying, setCopying] = useState(false);
  const [message, setMessage] = useState("");
  const resolvedSourceId = sourceId && channels.some((channel) => channel.id === sourceId)
    ? sourceId
    : channels[0]?.id ?? null;
  const resolvedTargetId = targetId
    && targetId !== resolvedSourceId
    && channels.some((channel) => channel.id === targetId)
    ? targetId
    : channels.find((channel) => channel.id !== resolvedSourceId)?.id ?? null;

  const copy = async () => {
    if (!resolvedSourceId || !resolvedTargetId || resolvedSourceId === resolvedTargetId || groups.size === 0 || copying) return;
    setCopying(true);
    setMessage("");
    try {
      const [sourceResponse, targetResponse] = await Promise.all([
        fetch(`/api/settings/channel?channel=${resolvedSourceId}`, { cache: "no-store" }),
        fetch(`/api/settings/channel?channel=${resolvedTargetId}`, { cache: "no-store" }),
      ]);
      const source = await sourceResponse.json().catch(() => null) as ChannelConfigurationForCopy | null;
      const target = await targetResponse.json().catch(() => null) as ChannelConfigurationForCopy | null;
      if (!sourceResponse.ok || !targetResponse.ok || !source?.brief || !source.settings || !target?.brief || !target.settings) throw new Error("load_failed");
      const merged = mergeChannelConfiguration(source, target, groups);
      const saveResponse = await fetch("/api/settings/channel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channelId: resolvedTargetId, ...merged }),
      });
      const savedBody = await saveResponse.json().catch(() => null) as { ok?: boolean } | null;
      if (!saveResponse.ok || !savedBody?.ok) throw new Error("save_failed");
      setMessage("Выбранные группы скопированы. Автопилот целевого канала оставлен выключенным.");
    } catch {
      setMessage("Не удалось скопировать настройки. Сохранённые данные не изменены.");
    } finally {
      setCopying(false);
    }
  };

  return (
    <Card as="section" className="mt-5 overflow-hidden">
      <header className="flex items-start gap-3 border-b border-line px-5 py-5 sm:px-7"><span className="grid h-10 w-10 place-items-center rounded-sm bg-info-soft text-brand"><ArrowRightLeft className="h-5 w-5" aria-hidden /></span><div><h2 className="text-[18px] font-extrabold text-text">Копирование настроек</h2><p className="mt-1 text-[13px] text-text-3">Перенеси только нужные группы между каналами.</p></div></header>
      <div className="space-y-6 px-5 py-6 sm:px-7">
        {channels.length < 2 ? <p className="rounded-sm bg-surface-inset p-4 text-[13px] text-text-2">Для копирования нужно минимум два подключённых канала.</p> : <>
          <div className="grid gap-5 sm:grid-cols-2"><Field label="Откуда копировать" htmlFor="copy-source"><select id="copy-source" className={SELECT_CLASS} value={resolvedSourceId ?? ""} onChange={(event) => setSourceId(Number(event.currentTarget.value))}>{channels.map((channel) => <option key={channel.id} value={channel.id}>{channelName(channel)} · {NETWORK_LABEL[channel.network]}</option>)}</select></Field><Field label="Куда копировать" htmlFor="copy-target"><select id="copy-target" className={SELECT_CLASS} value={resolvedTargetId ?? ""} onChange={(event) => setTargetId(Number(event.currentTarget.value))}>{channels.filter((channel) => channel.id !== resolvedSourceId).map((channel) => <option key={channel.id} value={channel.id}>{channelName(channel)} · {NETWORK_LABEL[channel.network]}</option>)}</select></Field></div>
          <div><div className="mb-3 flex flex-wrap items-center justify-between gap-2"><p className="text-[13px] font-bold text-text">Что копировать</p><Button variant="ghost" size="sm" onClick={() => setGroups(new Set(groups.size === CHANNEL_COPY_GROUPS.length ? [] : CHANNEL_COPY_GROUPS))}>{groups.size === CHANNEL_COPY_GROUPS.length ? "Снять всё" : "Выбрать всё"}</Button></div><div className="grid gap-2 sm:grid-cols-2">{CHANNEL_COPY_GROUPS.map((group) => { const active = groups.has(group); return <button key={group} type="button" aria-pressed={active} onClick={() => setGroups((current) => { const next = new Set(current); if (next.has(group)) next.delete(group); else next.add(group); return next; })} className={cn("flex min-h-20 items-start gap-3 rounded-sm border p-3 text-left", active ? "border-brand bg-info-soft" : "border-line bg-surface")}><span className={cn("mt-0.5 grid h-6 w-6 place-items-center rounded-xs border", active ? "border-brand bg-brand text-white" : "border-line text-transparent")}><Check className="h-4 w-4" aria-hidden /></span><span><span className="block text-[13px] font-bold text-text">{COPY_LABELS[group].label}</span><span className="mt-0.5 block text-[11px] leading-relaxed text-text-3">{COPY_LABELS[group].description}</span></span></button>; })}</div></div>
          {message ? <p role="status" className="rounded-sm bg-surface-inset p-3 text-[13px] text-text-2">{message}</p> : null}
          <div className="flex justify-end"><Button variant="brand" loading={copying} disabled={!resolvedTargetId || groups.size === 0} onClick={() => void copy()}><Copy className="h-4 w-4" aria-hidden />Скопировать выбранное</Button></div>
        </>}
      </div>
    </Card>
  );
}

export function SettingsPreviewPanel() {
  const store = useStore();
  const channels = useMemo(() => store.realChannels.filter((channel) => channel.is_active), [store.realChannels]);
  const [channelId, setChannelId] = useState<number | null>(null);
  const [topic, setTopic] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState("");
  const [report, setReport] = useState<AppliedSettingReport[]>([]);
  const [quota, setQuota] = useState({ used: 0, limit: 10, remaining: 10 });
  const [error, setError] = useState("");
  const resolvedChannelId = channelId && channels.some((channel) => channel.id === channelId)
    ? channelId
    : channels[0]?.id ?? null;
  useEffect(() => { fetch("/api/settings/preview", { cache: "no-store" }).then((response) => response.json()).then((body) => { if (body?.ok) setQuota({ used: body.used, limit: body.limit, remaining: body.remaining }); }).catch(() => undefined); }, []);

  const run = async () => {
    if (!resolvedChannelId || topic.trim().length < 3 || running) return;
    setRunning(true); setError(""); setResult(""); setReport([]);
    try {
      const response = await fetch("/api/settings/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ channelId: resolvedChannelId, topic }) });
      const body = await response.json().catch(() => null) as { ok?: boolean; text?: string; report?: AppliedSettingReport[]; used?: number; limit?: number; remaining?: number; error?: string } | null;
      if (body?.used != null && body.limit != null && body.remaining != null) {
        setQuota({ used: body.used, limit: body.limit, remaining: body.remaining });
      }
      if (!response.ok || !body?.ok || !body.text) {
        throw new Error(body?.error === "preview_limit"
          ? "Тестовый лимит на сегодня исчерпан."
          : body?.error === "preview_provider_unavailable"
            ? "ИИ-провайдер временно недоступен. Попытка учтена в отдельном тестовом лимите."
            : "Не удалось создать тестовый пост.");
      }
      setResult(body.text); setReport(body.report ?? []); setQuota({ used: body.used ?? quota.used + 1, limit: body.limit ?? 10, remaining: body.remaining ?? Math.max(0, quota.remaining - 1) });
    } catch (runError) { setError(runError instanceof Error ? runError.message : "Не удалось создать тестовый пост."); }
    finally { setRunning(false); }
  };

  return (
    <Card as="section" className="mb-5 overflow-hidden">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-5 sm:px-7"><div className="flex items-start gap-3"><span className="grid h-10 w-10 place-items-center rounded-sm bg-info-soft text-brand"><Sparkles className="h-5 w-5" aria-hidden /></span><div><h2 className="text-[18px] font-extrabold text-text">Проверить настройки</h2><p className="mt-1 text-[13px] text-text-3">Создаёт временный пост и показывает применённые группы. Ничего не публикуется.</p></div></div><Badge tone={quota.remaining > 2 ? "brand" : "fire"}>{quota.used} из {quota.limit} сегодня</Badge></header>
      <div className="space-y-5 px-5 py-6 sm:px-7">
        <div className="grid gap-4 sm:grid-cols-[minmax(0,15rem)_minmax(0,1fr)_auto] sm:items-end"><Field label="Канал" htmlFor="preview-channel"><select id="preview-channel" className={SELECT_CLASS} value={resolvedChannelId ?? ""} onChange={(event) => setChannelId(Number(event.currentTarget.value))}>{channels.map((channel) => <option key={channel.id} value={channel.id}>{channelName(channel)}</option>)}</select></Field><Field label="Тема тестового поста" htmlFor="preview-topic"><Input id="preview-topic" maxLength={500} value={topic} onChange={(event) => setTopic(event.currentTarget.value)} placeholder="Например: три ошибки при заключении договора" /></Field><Button variant="brand" loading={running} disabled={!resolvedChannelId || topic.trim().length < 3 || quota.remaining <= 0} onClick={() => void run()}><Play className="h-4 w-4" aria-hidden />Проверить</Button></div>
        <p className="flex items-center gap-1.5 text-[12px] text-text-3"><CircleHelp className="h-4 w-4" aria-hidden />Отдельный лимит: {quota.remaining} из {quota.limit} проверок осталось. Основные генерации не расходуются.</p>
        {error ? <p role="alert" className="rounded-sm bg-danger-soft p-3 text-[13px] text-danger-text">{error}</p> : null}
        {result ? <div className="grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(18rem,.8fr)]"><article className="rounded-md border border-line bg-surface-inset p-4"><p className="mb-3 text-[12px] font-bold uppercase tracking-wide text-text-3">Тестовый пост</p><p className="whitespace-pre-wrap text-[14px] leading-7 text-text">{result}</p></article><aside className="rounded-md border border-line bg-surface p-4"><p className="mb-3 text-[12px] font-bold uppercase tracking-wide text-text-3">Отчёт применения</p><ul className="space-y-3">{report.map((item) => <li key={item.id} className="flex items-start gap-2"><span className={cn("mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full", item.status === "applied" ? "bg-success-soft text-success-text" : "bg-surface-inset text-text-3")}><Check className="h-3 w-3" aria-hidden /></span><span><span className="block text-[12px] font-bold text-text">{item.label}</span><span className="mt-0.5 block text-[11px] leading-relaxed text-text-3">{item.detail}</span></span></li>)}</ul></aside></div> : null}
      </div>
    </Card>
  );
}
