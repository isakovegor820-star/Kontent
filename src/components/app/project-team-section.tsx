"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  Check,
  Clipboard,
  MailPlus,
  RefreshCw,
  Trash2,
  UserRoundPlus,
  Users,
} from "lucide-react";

import { useProjects } from "@/components/app/project-provider";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Badge, Card, Field, Input } from "@/components/ui/primitives";
import type { ClientProjectRole } from "@/lib/project-client";
import { cn } from "@/lib/utils";

type ProjectMember = {
  userId: number;
  name: string | null;
  email: string | null;
  avatar: string | null;
  role: ClientProjectRole;
  version: number;
  joinedAt: string;
};

type InvitationRole = Exclude<ClientProjectRole, "owner">;
type InvitationStatus = "pending" | "expired" | "accepted" | "revoked";

type ProjectInvitation = {
  id: number;
  email: string;
  role: InvitationRole;
  status: InvitationStatus;
  expiresAt: string;
  createdAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
};

type ApiBody = Record<string, unknown> & { error?: string; requestId?: string };
type Feedback = { kind: "success" | "error"; text: string } | null;
type Confirmation =
  | { kind: "member"; member: ProjectMember }
  | { kind: "invitation"; invitation: ProjectInvitation }
  | null;

const ROLE_LABEL: Record<ClientProjectRole, string> = {
  owner: "Владелец",
  author: "Автор",
  approver: "Согласующий",
  publisher: "Публикатор",
};

const INVITATION_STATUS: Record<InvitationStatus, { label: string; tone: "brand" | "success" | "danger" | "neutral" }> = {
  pending: { label: "Ожидает", tone: "brand" },
  expired: { label: "Истекло", tone: "neutral" },
  accepted: { label: "Принято", tone: "success" },
  revoked: { label: "Отозвано", tone: "danger" },
};

const TIMEZONES = [
  "Europe/Kaliningrad",
  "Europe/Moscow",
  "Europe/Samara",
  "Asia/Yekaterinburg",
  "Asia/Omsk",
  "Asia/Krasnoyarsk",
  "Asia/Irkutsk",
  "Asia/Yakutsk",
  "Asia/Vladivostok",
  "Asia/Magadan",
  "Asia/Kamchatka",
  "UTC",
] as const;

const SELECT_CLASS = [
  "min-h-11 w-full rounded-xs border border-line bg-surface px-3 text-base text-text sm:text-[14px]",
  "focus:border-brand focus:outline-none focus-visible:ring-4 focus-visible:ring-brand/15",
  "disabled:cursor-not-allowed disabled:opacity-50",
].join(" ");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" ? value : value == null ? null : null;
}

function isRole(value: unknown): value is ClientProjectRole {
  return value === "owner" || value === "author" || value === "approver" || value === "publisher";
}

function isInvitationRole(value: unknown): value is InvitationRole {
  return value === "author" || value === "approver" || value === "publisher";
}

function isInvitationStatus(value: unknown): value is InvitationStatus {
  return value === "pending" || value === "expired" || value === "accepted" || value === "revoked";
}

export function parseProjectMembers(value: unknown): ProjectMember[] | null {
  if (!isRecord(value) || value.ok !== true || !Array.isArray(value.members)) return null;
  const members: ProjectMember[] = [];
  for (const item of value.members) {
    if (!isRecord(item)) return null;
    const userId = positiveInteger(item.userId);
    const version = positiveInteger(item.version);
    if (!userId || !version || !isRole(item.role) || typeof item.joinedAt !== "string") return null;
    members.push({
      userId,
      version,
      role: item.role,
      joinedAt: item.joinedAt,
      name: nullableText(item.name),
      email: nullableText(item.email),
      avatar: nullableText(item.avatar),
    });
  }
  return members;
}

function parseInvitation(value: unknown): ProjectInvitation | null {
  if (!isRecord(value)) return null;
  const id = positiveInteger(value.id);
  if (
    !id
    || typeof value.email !== "string"
    || !isInvitationRole(value.role)
    || !isInvitationStatus(value.status)
    || typeof value.expiresAt !== "string"
    || typeof value.createdAt !== "string"
  ) return null;
  return {
    id,
    email: value.email,
    role: value.role,
    status: value.status,
    expiresAt: value.expiresAt,
    createdAt: value.createdAt,
    acceptedAt: nullableText(value.acceptedAt),
    revokedAt: nullableText(value.revokedAt),
  };
}

export function parseProjectInvitations(value: unknown): ProjectInvitation[] | null {
  if (!isRecord(value) || value.ok !== true || !Array.isArray(value.invitations)) return null;
  const invitations = value.invitations.map(parseInvitation);
  return invitations.every((item): item is ProjectInvitation => item !== null) ? invitations : null;
}

export function projectTeamErrorMessage(code: unknown): string {
  switch (code) {
    case "invalid_name":
      return "Укажи название проекта длиной до 160 символов.";
    case "invalid_timezone":
      return "Выбери корректный часовой пояс.";
    case "invalid_email":
      return "Введи корректный адрес электронной почты.";
    case "invitation_pending":
      return "Для этого адреса уже действует приглашение. Сначала отзови его или дождись окончания срока.";
    case "already_member":
      return "Этот человек уже состоит в проекте.";
    case "last_owner":
      return "В проекте должен остаться хотя бы один владелец. Сначала назначь владельцем другого участника.";
    case "version_conflict":
      return "Состав команды изменился в другой вкладке. Список обновлён — повтори действие.";
    case "member_not_found":
      return "Участник уже удалён. Список обновлён.";
    case "invitation_not_found":
      return "Приглашение уже удалено или не существует. Обнови список.";
    case "invitation_used":
      return "Приглашение уже принято и больше не может быть отозвано.";
    case "access_denied":
      return "Недостаточно прав для управления командой этого проекта.";
    case "unauthorized":
      return "Сессия истекла. Войди в аккаунт снова.";
    case "network":
      return "Нет связи с сервером. Проверь подключение и повтори попытку.";
    default:
      return "Не удалось сохранить изменение. Повтори попытку.";
  }
}

async function requestJson(url: string, init?: RequestInit): Promise<{ response: Response; body: ApiBody | null }> {
  try {
    const response = await fetch(url, { cache: "no-store", ...init });
    const parsed = await response.json().catch(() => null);
    return { response, body: isRecord(parsed) ? parsed as ApiBody : null };
  } catch {
    throw new Error("network");
  }
}

function initialTimezone(): string {
  if (typeof Intl === "undefined") return "Europe/Moscow";
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return timezone || "Europe/Moscow";
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "дата не указана";
  return new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", year: "numeric" }).format(date);
}

function invitationDate(invitation: ProjectInvitation): { label: string; value: string } {
  if (invitation.status === "accepted" && invitation.acceptedAt) {
    return { label: "Принято", value: invitation.acceptedAt };
  }
  if (invitation.status === "revoked" && invitation.revokedAt) {
    return { label: "Отозвано", value: invitation.revokedAt };
  }
  return { label: invitation.status === "expired" ? "Истекло" : "Действует до", value: invitation.expiresAt };
}

export function ProjectTeamSection() {
  const projects = useProjects();
  const current = projects.current;
  const owner = current?.role === "owner";
  const titleId = useId();
  const nameMessageId = useId();
  const emailMessageId = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const inviteLinkRef = useRef<HTMLInputElement>(null);
  const requestSequence = useRef(0);

  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [invitations, setInvitations] = useState<ProjectInvitation[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [confirmation, setConfirmation] = useState<Confirmation>(null);

  const [projectName, setProjectName] = useState("");
  const [projectTimezone, setProjectTimezone] = useState(initialTimezone);
  const [projectNameError, setProjectNameError] = useState<string | null>(null);
  const [creatingProject, setCreatingProject] = useState(false);

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<InvitationRole>("author");
  const [inviteTtl, setInviteTtl] = useState(7);
  const [inviteEmailError, setInviteEmailError] = useState<string | null>(null);
  const [inviteUrl, setInviteUrl] = useState("");
  const [copied, setCopied] = useState(false);

  const timezoneOptions = useMemo(() => {
    return Array.from(new Set([projectTimezone, ...TIMEZONES])).filter(Boolean);
  }, [projectTimezone]);

  const loadTeam = useCallback(async () => {
    const projectId = current?.id;
    if (!projectId) return;
    const sequence = ++requestSequence.current;
    setLoading(true);
    setLoadError(false);
    try {
      const memberRequest = requestJson(`/api/projects/${projectId}/members`);
      const invitationRequest = owner
        ? requestJson(`/api/projects/${projectId}/invitations`)
        : Promise.resolve(null);
      const [memberResult, invitationResult] = await Promise.all([memberRequest, invitationRequest]);
      const nextMembers = memberResult.response.ok ? parseProjectMembers(memberResult.body) : null;
      const nextInvitations = owner && invitationResult
        ? invitationResult.response.ok ? parseProjectInvitations(invitationResult.body) : null
        : [];
      if (!nextMembers || !nextInvitations) throw new Error("load_failed");
      if (sequence !== requestSequence.current) return;
      setMembers(nextMembers);
      setInvitations(nextInvitations);
    } catch {
      if (sequence !== requestSequence.current) return;
      setLoadError(true);
    } finally {
      if (sequence === requestSequence.current) setLoading(false);
    }
  }, [current?.id, owner]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setInviteUrl("");
      setCopied(false);
      if (!projects.ready || !current) {
        requestSequence.current += 1;
        setMembers([]);
        setInvitations([]);
        setLoading(false);
        return;
      }
      void loadTeam();
    });
    return () => {
      cancelled = true;
    };
  }, [projects.ready, current, loadTeam]);

  const showRequestError = useCallback(async (code: unknown) => {
    setFeedback({ kind: "error", text: projectTeamErrorMessage(code) });
    if (code === "version_conflict" || code === "member_not_found" || code === "invitation_not_found") {
      await loadTeam();
    }
  }, [loadTeam]);

  const createNewProject = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (creatingProject) return;
    const name = projectName.trim().replace(/\s+/g, " ");
    if (!name || name.length > 160) {
      setProjectNameError("Укажи название проекта длиной до 160 символов.");
      requestAnimationFrame(() => nameRef.current?.focus());
      return;
    }
    setProjectNameError(null);
    setFeedback(null);
    setCreatingProject(true);
    const result = await projects.createProject({ name, timezone: projectTimezone });
    setCreatingProject(false);
    if (!result.ok) {
      setFeedback({ kind: "error", text: projectTeamErrorMessage(result.error) });
      return;
    }
    setProjectName("");
  };

  const changeRole = async (member: ProjectMember, role: ClientProjectRole) => {
    if (!current || !owner || role === member.role || savingKey) return;
    setSavingKey(`member-role-${member.userId}`);
    setFeedback(null);
    try {
      const { response, body } = await requestJson(`/api/projects/${current.id}/members/${member.userId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role, expectedVersion: member.version }),
      });
      if (!response.ok || body?.ok !== true) {
        await showRequestError(body?.error);
        return;
      }
      setMembers((items) => items.map((item) => item.userId === member.userId
        ? { ...item, role, version: positiveInteger(isRecord(body.member) ? body.member.version : null) ?? item.version + 1 }
        : item));
      await projects.refresh();
      setFeedback({ kind: "success", text: `Роль участника изменена: ${ROLE_LABEL[role].toLowerCase()}.` });
    } catch (error) {
      await showRequestError(error instanceof Error ? error.message : "network");
    } finally {
      setSavingKey(null);
    }
  };

  const createInvitation = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!current || !owner || savingKey) return;
    const email = inviteEmail.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      setInviteEmailError("Введи корректный адрес электронной почты.");
      requestAnimationFrame(() => emailRef.current?.focus());
      return;
    }
    setInviteEmailError(null);
    setFeedback(null);
    setSavingKey("invitation-create");
    try {
      const { response, body } = await requestJson(`/api/projects/${current.id}/invitations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, role: inviteRole, ttlDays: inviteTtl }),
      });
      const invitation = parseInvitation(body?.invitation);
      if (!response.ok || body?.ok !== true || !invitation || typeof body.inviteUrl !== "string") {
        await showRequestError(body?.error);
        return;
      }
      setInvitations((items) => [invitation, ...items.filter((item) => item.id !== invitation.id)]);
      setInviteEmail("");
      setInviteUrl(body.inviteUrl);
      setCopied(false);
      setFeedback({ kind: "success", text: "Приглашение создано. Скопируй ссылку и передай её лично." });
    } catch (error) {
      await showRequestError(error instanceof Error ? error.message : "network");
    } finally {
      setSavingKey(null);
    }
  };

  const copyInvitation = async () => {
    if (!inviteUrl) return;
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      setFeedback({ kind: "success", text: "Ссылка приглашения скопирована." });
    } catch {
      inviteLinkRef.current?.focus();
      inviteLinkRef.current?.select();
      setCopied(false);
      setFeedback({ kind: "error", text: "Не удалось скопировать автоматически. Выдели ссылку и скопируй вручную." });
    }
  };

  const confirmRemoval = async () => {
    if (!current || !owner || !confirmation || savingKey) return;
    const action = confirmation;
    const key = action.kind === "member" ? `member-remove-${action.member.userId}` : `invitation-remove-${action.invitation.id}`;
    setSavingKey(key);
    setFeedback(null);
    try {
      const url = action.kind === "member"
        ? `/api/projects/${current.id}/members/${action.member.userId}`
        : `/api/projects/${current.id}/invitations/${action.invitation.id}`;
      const init: RequestInit = action.kind === "member"
        ? {
            method: "DELETE",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ expectedVersion: action.member.version }),
          }
        : { method: "DELETE" };
      const { response, body } = await requestJson(url, init);
      if (!response.ok || body?.ok !== true) {
        await showRequestError(body?.error);
        return;
      }
      if (action.kind === "member") {
        setMembers((items) => items.filter((item) => item.userId !== action.member.userId));
        await projects.refresh();
        setFeedback({ kind: "success", text: "Участник удалён из проекта." });
      } else {
        setInvitations((items) => items.map((item) => item.id === action.invitation.id
          ? { ...item, status: "revoked", revokedAt: new Date().toISOString() }
          : item));
        setFeedback({ kind: "success", text: "Приглашение отозвано." });
      }
      setConfirmation(null);
    } catch (error) {
      await showRequestError(error instanceof Error ? error.message : "network");
    } finally {
      setSavingKey(null);
    }
  };

  const confirmationCopy = confirmation?.kind === "member"
    ? {
        title: "Удалить участника?",
        description: `${confirmation.member.name || confirmation.member.email || "Участник"} потеряет доступ к проекту. Созданные материалы останутся в проекте.`,
        label: "Удалить участника",
      }
    : confirmation?.kind === "invitation"
      ? {
          title: "Отозвать приглашение?",
          description: `Ссылка для ${confirmation.invitation.email} перестанет работать.`,
          label: "Отозвать приглашение",
        }
      : null;

  return (
    <section aria-labelledby={titleId} className="mb-5 break-inside-avoid">
      <Card className="overflow-hidden">
        <header className="flex items-start gap-3.5 border-b border-line px-5 py-5 sm:px-7">
          <span aria-hidden className="grid h-10 w-10 shrink-0 place-items-center rounded-sm bg-surface-inset text-text-2">
            <Users className="h-5 w-5" strokeWidth={1.75} />
          </span>
          <div className="min-w-0">
            <h2 id={titleId} className="text-[17px] font-extrabold tracking-tight text-text">Проект и команда</h2>
            <p className="mt-1 text-[14px] leading-relaxed text-text-2">
              Создавай рабочие пространства, распределяй роли и выдавай доступ по одноразовой ссылке.
            </p>
          </div>
        </header>

        <div className="space-y-10 px-5 py-6 sm:px-7 sm:py-7" aria-busy={loading || savingKey !== null || undefined}>
          {!projects.ready ? (
            <div role="status" className="space-y-2">
              <span className="sr-only">Открываем проект и команду</span>
              <div className="skeleton h-5 w-40" />
              <div className="skeleton h-20 w-full rounded-sm" />
            </div>
          ) : projects.error && !current ? (
            <div role="alert" className="rounded-sm bg-fire-soft p-4 text-[14px] leading-relaxed text-fire-text">
              <p className="font-semibold">Проекты не загрузились</p>
              <p className="mt-1">Проверь подключение и повтори попытку.</p>
              <Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => void projects.refresh()}>
                <RefreshCw className="h-4 w-4" aria-hidden />
                Повторить
              </Button>
            </div>
          ) : !current ? (
            <p role="status" className="rounded-sm bg-surface-inset p-4 text-[14px] leading-relaxed text-text-2">
              Текущий проект не выбран. Выбери его в боковом меню или создай новый ниже.
            </p>
          ) : (
            <div>
              <h3 className="text-[15px] font-extrabold text-text">Текущий проект</h3>
              <dl className="mt-3 grid gap-4 rounded-sm bg-surface-inset p-4 sm:grid-cols-2">
                <div className="min-w-0 sm:col-span-2">
                  <dt className="text-[12px] font-semibold text-text-3">Название</dt>
                  <dd className="mt-1 break-words text-[15px] font-bold text-text">{current.name}</dd>
                </div>
                <div>
                  <dt className="text-[12px] font-semibold text-text-3">Твоя роль</dt>
                  <dd className="mt-1"><Badge tone={owner ? "brand" : "neutral"}>{ROLE_LABEL[current.role]}</Badge></dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-[12px] font-semibold text-text-3">Часовой пояс</dt>
                  <dd className="mt-1 break-words text-[14px] font-semibold text-text">{current.timezone}</dd>
                </div>
              </dl>
            </div>
          )}

          <div>
            <h3 className="text-[15px] font-extrabold text-text">Создать проект</h3>
            <p className="mt-1 max-w-[65ch] text-[13px] leading-relaxed text-text-3">
              Новый проект будет выбран сразу, а ты станешь его владельцем.
            </p>
            <form noValidate onSubmit={createNewProject} className="mt-4 space-y-4">
              <Field label="Название проекта" htmlFor="project-team-name" required error={projectNameError ?? undefined} messageId={nameMessageId}>
                <Input
                  ref={nameRef}
                  id="project-team-name"
                  name="projectName"
                  required
                  value={projectName}
                  maxLength={160}
                  autoComplete="organization"
                  placeholder="Например: Юридическая практика"
                  disabled={creatingProject}
                  aria-invalid={projectNameError ? true : undefined}
                  aria-describedby={projectNameError ? nameMessageId : undefined}
                  onChange={(event) => {
                    setProjectName(event.currentTarget.value);
                    if (projectNameError) setProjectNameError(null);
                  }}
                />
              </Field>
              <Field label="Часовой пояс" htmlFor="project-team-timezone">
                <select
                  id="project-team-timezone"
                  name="timezone"
                  value={projectTimezone}
                  disabled={creatingProject}
                  className={SELECT_CLASS}
                  onChange={(event) => setProjectTimezone(event.currentTarget.value)}
                >
                  {timezoneOptions.map((timezone) => <option key={timezone} value={timezone}>{timezone}</option>)}
                </select>
              </Field>
              <Button type="submit" variant="outline" loading={creatingProject}>
                <UserRoundPlus className="h-4 w-4" aria-hidden />
                Создать проект
              </Button>
            </form>
          </div>

          {current ? (
            <div>
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <h3 className="text-[15px] font-extrabold text-text">Участники</h3>
                  <p className="mt-1 text-[13px] leading-relaxed text-text-3">
                    {owner ? "Владелец назначает роли и управляет доступом." : "Состав команды доступен только для просмотра."}
                  </p>
                </div>
                <Button type="button" variant="ghost" size="sm" loading={loading} onClick={() => void loadTeam()}>
                  <RefreshCw className="h-4 w-4" aria-hidden />
                  Обновить
                </Button>
              </div>

              {loadError ? (
                <div role="alert" className="mt-4 rounded-sm bg-fire-soft p-4 text-[14px] leading-relaxed text-fire-text">
                  <p className="font-semibold">Команда не загрузилась</p>
                  <p className="mt-1">Текущий проект продолжает работать. Повтори загрузку списка.</p>
                  <Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => void loadTeam()}>
                    Повторить
                  </Button>
                </div>
              ) : loading && members.length === 0 ? (
                <p role="status" className="mt-4 rounded-sm bg-surface-inset p-4 text-[14px] text-text-2">Загружаем участников…</p>
              ) : members.length === 0 ? (
                <p role="status" className="mt-4 rounded-sm bg-surface-inset p-4 text-[14px] text-text-2">В проекте пока нет участников.</p>
              ) : (
                <ul className="mt-4 divide-y divide-line" aria-label="Участники проекта">
                  {members.map((member) => {
                    const label = member.name || member.email || `Участник ${member.userId}`;
                    const roleId = `project-member-role-${member.userId}`;
                    const busy = savingKey?.includes(`-${member.userId}`) === true;
                    return (
                      <li key={member.userId} className="py-4 first:pt-0 last:pb-0">
                        <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center">
                          <div className="min-w-0 flex-1">
                            <p className="break-words text-[14px] font-bold text-text">{label}</p>
                            {member.name && member.email ? <p className="mt-0.5 break-all text-[12px] text-text-3">{member.email}</p> : null}
                            <p className="mt-1 text-[12px] text-text-3">В проекте с {formatDate(member.joinedAt)}</p>
                          </div>
                          {owner ? (
                            <div className="flex min-w-0 flex-col gap-2 min-[400px]:flex-row sm:items-center">
                              <label htmlFor={roleId} className="sr-only">Роль участника {label}</label>
                              <select
                                id={roleId}
                                value={member.role}
                                disabled={Boolean(savingKey)}
                                aria-label={`Роль участника ${label}`}
                                aria-busy={busy || undefined}
                                className={cn(SELECT_CLASS, "min-[400px]:w-auto")}
                                onChange={(event) => void changeRole(member, event.currentTarget.value as ClientProjectRole)}
                              >
                                {(Object.keys(ROLE_LABEL) as ClientProjectRole[]).map((role) => (
                                  <option key={role} value={role}>{ROLE_LABEL[role]}</option>
                                ))}
                              </select>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="text-danger-text"
                                disabled={Boolean(savingKey)}
                                aria-label={`Удалить участника ${label}`}
                                onClick={() => setConfirmation({ kind: "member", member })}
                              >
                                <Trash2 className="h-4 w-4" aria-hidden />
                                Удалить
                              </Button>
                            </div>
                          ) : (
                            <Badge tone="neutral">{ROLE_LABEL[member.role]}</Badge>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          ) : null}

          {current && owner ? (
            <div>
              <h3 className="text-[15px] font-extrabold text-text">Пригласить участника</h3>
              <p className="mt-1 text-[13px] leading-relaxed text-text-3">
                Ссылка показывается один раз. Отправь её человеку с указанным адресом.
              </p>
              <form noValidate onSubmit={createInvitation} className="mt-4 space-y-4">
                <Field label="Электронная почта" htmlFor="project-invite-email" required error={inviteEmailError ?? undefined} messageId={emailMessageId}>
                  <Input
                    ref={emailRef}
                    id="project-invite-email"
                    name="inviteEmail"
                    type="email"
                    required
                    inputMode="email"
                    autoComplete="email"
                    value={inviteEmail}
                    placeholder="name@example.ru"
                    disabled={savingKey === "invitation-create"}
                    aria-invalid={inviteEmailError ? true : undefined}
                    aria-describedby={inviteEmailError ? emailMessageId : undefined}
                    onChange={(event) => {
                      setInviteEmail(event.currentTarget.value);
                      if (inviteEmailError) setInviteEmailError(null);
                    }}
                  />
                </Field>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Роль" htmlFor="project-invite-role">
                    <select
                      id="project-invite-role"
                      name="inviteRole"
                      value={inviteRole}
                      disabled={savingKey === "invitation-create"}
                      className={SELECT_CLASS}
                      onChange={(event) => setInviteRole(event.currentTarget.value as InvitationRole)}
                    >
                      <option value="author">Автор</option>
                      <option value="approver">Согласующий</option>
                      <option value="publisher">Публикатор</option>
                    </select>
                  </Field>
                  <Field label="Срок ссылки" htmlFor="project-invite-ttl">
                    <select
                      id="project-invite-ttl"
                      name="inviteTtl"
                      value={inviteTtl}
                      disabled={savingKey === "invitation-create"}
                      className={SELECT_CLASS}
                      onChange={(event) => setInviteTtl(Number(event.currentTarget.value))}
                    >
                      <option value={1}>1 день</option>
                      <option value={3}>3 дня</option>
                      <option value={7}>7 дней</option>
                      <option value={14}>14 дней</option>
                      <option value={30}>30 дней</option>
                    </select>
                  </Field>
                </div>
                <Button type="submit" variant="outline" loading={savingKey === "invitation-create"}>
                  <MailPlus className="h-4 w-4" aria-hidden />
                  Создать приглашение
                </Button>
              </form>

              {inviteUrl ? (
                <div className="mt-5 rounded-sm border border-brand/25 bg-info-soft p-4" role="status" aria-label="Ссылка приглашения готова">
                  <p className="flex items-center gap-2 text-[14px] font-bold text-info-text">
                    <Check className="h-4 w-4" aria-hidden />
                    Ссылка готова
                  </p>
                  <p className="mt-1 text-[13px] leading-relaxed text-text-2">
                    Скопируй сейчас: после ухода со страницы восстановить эту ссылку нельзя.
                  </p>
                  <div className="mt-3 flex min-w-0 flex-col gap-2 sm:flex-row">
                    <Input ref={inviteLinkRef} value={inviteUrl} readOnly aria-label="Одноразовая ссылка приглашения" className="min-w-0 font-mono text-[13px]" />
                    <Button type="button" variant="outline" className="shrink-0" onClick={() => void copyInvitation()}>
                      <Clipboard className="h-4 w-4" aria-hidden />
                      {copied ? "Скопировано" : "Скопировать"}
                    </Button>
                  </div>
                </div>
              ) : null}

              <div className="mt-8">
                <h3 className="text-[15px] font-extrabold text-text">Приглашения</h3>
                {loading && invitations.length === 0 ? (
                  <p role="status" className="mt-3 rounded-sm bg-surface-inset p-4 text-[14px] text-text-2">Загружаем приглашения…</p>
                ) : invitations.length === 0 ? (
                  <p role="status" className="mt-3 rounded-sm bg-surface-inset p-4 text-[14px] leading-relaxed text-text-2">
                    Приглашений пока нет. Создай первое по форме выше.
                  </p>
                ) : (
                  <ul className="mt-3 divide-y divide-line" aria-label="Приглашения в проект">
                    {invitations.map((invitation) => {
                      const status = INVITATION_STATUS[invitation.status];
                      const date = invitationDate(invitation);
                      return (
                        <li key={invitation.id} className="py-4 first:pt-0 last:pb-0">
                          <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center">
                            <div className="min-w-0 flex-1">
                              <p className="break-all text-[14px] font-bold text-text">{invitation.email}</p>
                              <p className="mt-1 text-[12px] leading-relaxed text-text-3">
                                {ROLE_LABEL[invitation.role]} · {date.label} <time dateTime={date.value}>{formatDate(date.value)}</time>
                              </p>
                            </div>
                            <div className="flex flex-wrap items-center gap-2">
                              <Badge tone={status.tone}>{status.label}</Badge>
                              {invitation.status === "pending" ? (
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  className="text-danger-text"
                                  disabled={Boolean(savingKey)}
                                  onClick={() => setConfirmation({ kind: "invitation", invitation })}
                                >
                                  Отозвать
                                </Button>
                              ) : null}
                            </div>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </div>
          ) : null}

          <p
            role="status"
            aria-live="polite"
            className={cn(
              "text-[13px] leading-relaxed font-medium",
              feedback?.kind === "success" ? "text-success-text" : "sr-only",
            )}
          >
            {feedback?.kind === "success" ? feedback.text : ""}
          </p>
          {feedback?.kind === "error" ? (
            <p role="alert" className="rounded-sm bg-danger-soft p-3 text-[13px] leading-relaxed font-medium text-danger-text">
              {feedback.text}
            </p>
          ) : null}
        </div>
      </Card>

      <ConfirmDialog
        open={Boolean(confirmationCopy)}
        title={confirmationCopy?.title ?? "Подтвердить действие"}
        description={confirmationCopy?.description ?? ""}
        confirmLabel={confirmationCopy?.label ?? "Подтвердить"}
        busy={Boolean(savingKey)}
        onCancel={() => {
          if (!savingKey) setConfirmation(null);
        }}
        onConfirm={() => void confirmRemoval()}
      />
    </section>
  );
}
