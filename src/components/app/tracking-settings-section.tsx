"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Activity,
  Check,
  Clipboard,
  Link2,
  Pencil,
  RefreshCw,
  Trash2,
  TriangleAlert,
} from "lucide-react";

import { useProjects } from "@/components/app/project-provider";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Badge, Card, Field, Input } from "@/components/ui/primitives";
import { validateUtmFields, type UtmFieldErrors } from "@/lib/tracking-field-validation";
import { UTM_FIELDS, type UtmField, type UtmValues } from "@/lib/utm";
import { cn } from "@/lib/utils";

type TrackingStatus = "not_connected" | "pending_verification" | "verification_failed" | "active" | "paused";

export type ProjectTrackingSettings = {
  status: TrackingStatus;
  siteOrigin: string | null;
  publicKey: string | null;
  attributionWindowDays: number;
  version: number;
  verifiedAt: string | null;
  lastPingAt: string | null;
  signalReceivedAt: string | null;
  verificationCheckedAt: string | null;
  verificationErrorCode: string | null;
  verificationFilePath: string;
  verificationFileContent: string | null;
};

export type ProjectUtmTemplate = {
  id: number;
  name: string;
  values: UtmValues;
  version: number;
  updatedAt: string;
};

type ApiBody = Record<string, unknown> & { error?: string; requestId?: string };
type Feedback = { kind: "success" | "info" | "error"; text: string } | null;
type TemplateFormValues = Record<UtmField, string>;

const EMPTY_TEMPLATE_VALUES: TemplateFormValues = {
  utm_source: "",
  utm_medium: "",
  utm_campaign: "",
  utm_content: "",
  utm_term: "",
};

const UTM_FIELD_COPY: Record<UtmField, { label: string; hint: string; placeholder: string }> = {
  utm_source: {
    label: "Источник",
    hint: "Откуда пришёл переход: Telegram, VK или рассылка.",
    placeholder: "telegram",
  },
  utm_medium: {
    label: "Тип трафика",
    hint: "Обычно social, cpc или email.",
    placeholder: "social",
  },
  utm_campaign: {
    label: "Кампания",
    hint: "Общее название продвижения без персональных данных.",
    placeholder: "bankruptcy_august",
  },
  utm_content: {
    label: "Вариант публикации",
    hint: "Помогает различать посты внутри одной кампании.",
    placeholder: "post_01",
  },
  utm_term: {
    label: "Ключевая тема",
    hint: "Необязательная тема или рекламная группа.",
    placeholder: "business_bankruptcy",
  },
};

const SELECT_CLASS = [
  "min-h-11 w-full rounded-xs border border-line bg-surface px-3 text-base text-text sm:text-[14px]",
  "focus:border-brand focus:outline-none focus-visible:ring-4 focus-visible:ring-brand/15",
  "disabled:cursor-not-allowed disabled:opacity-50",
].join(" ");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nullableString(value: unknown): string | null | undefined {
  if (value == null) return null;
  return typeof value === "string" ? value : undefined;
}

function isTrackingStatus(value: unknown): value is TrackingStatus {
  return value === "not_connected" || value === "pending_verification" || value === "verification_failed" || value === "active" || value === "paused";
}

function parseUtmValues(value: unknown): UtmValues | null {
  if (!isRecord(value)) return null;
  const parsed: UtmValues = {};
  for (const field of UTM_FIELDS) {
    const fieldValue = value[field];
    if (fieldValue == null) continue;
    if (typeof fieldValue !== "string") return null;
    parsed[field] = fieldValue;
  }
  return parsed;
}

export function parseTrackingSettingsResponse(value: unknown): ProjectTrackingSettings | null {
  if (!isRecord(value) || value.ok !== true || !isRecord(value.tracking)) return null;
  const tracking = value.tracking;
  const siteOrigin = nullableString(tracking.siteOrigin);
  const publicKey = nullableString(tracking.publicKey);
  const verifiedAt = nullableString(tracking.verifiedAt);
  const lastPingAt = nullableString(tracking.lastPingAt);
  const signalReceivedAt = nullableString(tracking.signalReceivedAt);
  const verificationCheckedAt = nullableString(tracking.verificationCheckedAt);
  const verificationErrorCode = nullableString(tracking.verificationErrorCode);
  const verificationFileContent = nullableString(tracking.verificationFileContent);
  const attributionWindowDays = Number(tracking.attributionWindowDays);
  const version = Number(tracking.version);
  if (
    !isTrackingStatus(tracking.status)
    || siteOrigin === undefined
    || publicKey === undefined
    || verifiedAt === undefined
    || lastPingAt === undefined
    || signalReceivedAt === undefined
    || verificationCheckedAt === undefined
    || verificationErrorCode === undefined
    || verificationFileContent === undefined
    || tracking.verificationFilePath !== "/.well-known/aurora-tracker-verification.txt"
    || !Number.isSafeInteger(attributionWindowDays)
    || attributionWindowDays < 1
    || attributionWindowDays > 90
    || !Number.isSafeInteger(version)
    || version < 0
  ) return null;
  if (
    tracking.status === "active"
    && (!siteOrigin || !publicKey || !verifiedAt || !verificationCheckedAt || !verificationFileContent)
  ) return null;
  return {
    status: tracking.status,
    siteOrigin,
    publicKey,
    attributionWindowDays,
    version,
    verifiedAt,
    lastPingAt,
    signalReceivedAt,
    verificationCheckedAt,
    verificationErrorCode,
    verificationFilePath: tracking.verificationFilePath,
    verificationFileContent,
  };
}

function parseUtmTemplate(value: unknown): ProjectUtmTemplate | null {
  if (!isRecord(value)) return null;
  const id = Number(value.id);
  const version = Number(value.version);
  const values = parseUtmValues(value.values);
  if (
    !Number.isSafeInteger(id)
    || id <= 0
    || typeof value.name !== "string"
    || !value.name.trim()
    || !values
    || !Number.isSafeInteger(version)
    || version <= 0
    || typeof value.updatedAt !== "string"
  ) return null;
  return {
    id,
    name: value.name,
    values,
    version,
    updatedAt: value.updatedAt,
  };
}

export function parseUtmTemplatesResponse(value: unknown): ProjectUtmTemplate[] | null {
  if (!isRecord(value) || value.ok !== true || !Array.isArray(value.templates)) return null;
  const templates = value.templates.map(parseUtmTemplate);
  return templates.every((template): template is ProjectUtmTemplate => template !== null)
    ? templates
    : null;
}

function parseUtmTemplateResponse(value: unknown): ProjectUtmTemplate | null {
  return isRecord(value) && value.ok === true ? parseUtmTemplate(value.template) : null;
}

export function trackingSettingsErrorMessage(code: unknown): string {
  switch (code) {
    case "invalid_origin":
      return "Укажи полный адрес сайта без пути, параметров и якоря, например https://example.ru.";
    case "invalid_window":
      return "Выбери срок атрибуции от 1 до 90 дней.";
    case "invalid_name":
      return "Укажи название шаблона длиной до 120 символов.";
    case "name_conflict":
      return "Шаблон с таким названием уже есть. Выбери другое название.";
    case "invalid_utm":
      return "Проверь UTM-значения: до 160 символов в каждом поле, без электронной почты и телефонов.";
    case "version_conflict":
      return "Настройки изменились в другой вкладке. Данные обновлены — повтори действие.";
    case "access_denied":
      return "Недостаточно прав для изменения настроек этого проекта.";
    case "unauthorized":
      return "Сессия истекла. Войди в аккаунт снова.";
    case "network":
      return "Нет связи с сервером. Проверь подключение и повтори попытку.";
    default:
      return "Не удалось выполнить действие. Повтори попытку.";
  }
}

async function requestJson(url: string, init?: RequestInit): Promise<{
  response: Response | null;
  body: ApiBody | null;
}> {
  try {
    const response = await fetch(url, { cache: "no-store", ...init });
    const value = await response.json().catch(() => null);
    return { response, body: isRecord(value) ? value as ApiBody : null };
  } catch {
    return { response: null, body: null };
  }
}

function responseError(response: Response | null, body: ApiBody | null): string {
  if (!response) return "network";
  if (typeof body?.error === "string") return body.error;
  if (response.status === 401) return "unauthorized";
  if (response.status === 403) return "access_denied";
  return "server";
}

function siteOriginError(value: string): string | null {
  const raw = value.trim();
  if (!raw) return "Укажи адрес сайта, где будет установлен трекер.";
  try {
    const url = new URL(raw);
    if (
      !(url.protocol === "http:" || url.protocol === "https:")
      || url.username
      || url.password
      || url.pathname !== "/"
      || url.search
      || url.hash
    ) return trackingSettingsErrorMessage("invalid_origin");
  } catch {
    return trackingSettingsErrorMessage("invalid_origin");
  }
  return null;
}

function formatDateTime(value: string | null): string {
  if (!value) return "сигналов пока нет";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "дата не указана";
  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function sortTemplates(templates: ProjectUtmTemplate[]): ProjectUtmTemplate[] {
  return [...templates].sort((left, right) => (
    left.name.localeCompare(right.name, "ru", { sensitivity: "base" }) || left.id - right.id
  ));
}

function valuesForForm(values: UtmValues): TemplateFormValues {
  return {
    utm_source: values.utm_source ?? "",
    utm_medium: values.utm_medium ?? "",
    utm_campaign: values.utm_campaign ?? "",
    utm_content: values.utm_content ?? "",
    utm_term: values.utm_term ?? "",
  };
}

function compactValues(values: TemplateFormValues): UtmValues {
  return Object.fromEntries(
    UTM_FIELDS
      .map((field) => [field, values[field].trim()] as const)
      .filter(([, value]) => Boolean(value)),
  ) as UtmValues;
}

export function trackingInstallSnippet(appOrigin: string, publicKey: string): string | null {
  if (!/^[A-Za-z0-9_-]{20,160}$/u.test(publicKey)) return null;
  try {
    const origin = new URL(appOrigin).origin;
    return `<script src="${origin}/api/tracking/client.js" data-project-key="${publicKey}"></script>`;
  } catch {
    return null;
  }
}

export function TrackingSettingsSection() {
  const projects = useProjects();
  const current = projects.current;
  const canManage = current?.role === "owner";
  const currentProjectIdRef = useRef<number | null>(current?.id ?? null);

  const titleId = useId();
  const originMessageId = useId();
  const windowMessageId = useId();
  const templateNameMessageId = useId();
  const templateValuesMessageId = useId();
  const originRef = useRef<HTMLInputElement>(null);
  const templateNameRef = useRef<HTMLInputElement>(null);
  const utmInputRefs = useRef<Partial<Record<UtmField, HTMLInputElement>>>({});
  const settingsSequence = useRef(0);
  const templatesSequence = useRef(0);

  const [settings, setSettings] = useState<ProjectTrackingSettings | null>(null);
  const [settingsProjectId, setSettingsProjectId] = useState<number | null>(null);
  const [settingsLoadError, setSettingsLoadError] = useState(false);
  const [siteOrigin, setSiteOrigin] = useState("");
  const [attributionWindowDays, setAttributionWindowDays] = useState(30);
  const [originError, setOriginError] = useState<string | null>(null);
  const [windowError, setWindowError] = useState<string | null>(null);
  const [settingsDirty, setSettingsDirty] = useState(false);

  const [templates, setTemplates] = useState<ProjectUtmTemplate[]>([]);
  const [templatesProjectId, setTemplatesProjectId] = useState<number | null>(null);
  const [templatesLoadError, setTemplatesLoadError] = useState(false);
  const [templateName, setTemplateName] = useState("");
  const [templateValues, setTemplateValues] = useState<TemplateFormValues>({ ...EMPTY_TEMPLATE_VALUES });
  const [templateNameError, setTemplateNameError] = useState<string | null>(null);
  const [templateValuesError, setTemplateValuesError] = useState<string | null>(null);
  const [templateFieldErrors, setTemplateFieldErrors] = useState<UtmFieldErrors>({});
  const [editingTemplateId, setEditingTemplateId] = useState<number | null>(null);
  const [deleteTemplate, setDeleteTemplate] = useState<ProjectUtmTemplate | null>(null);

  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [copied, setCopied] = useState(false);
  const [installCopied, setInstallCopied] = useState(false);
  const [verificationCopied, setVerificationCopied] = useState(false);
  const [appOrigin, setAppOrigin] = useState("");

  useEffect(() => {
    const timer = window.setTimeout(() => setAppOrigin(window.location.origin), 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    currentProjectIdRef.current = current?.id ?? null;
    const timer = window.setTimeout(() => {
      setCopied(false);
      setInstallCopied(false);
      setVerificationCopied(false);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [current?.id]);

  const visibleSettings = current && settingsProjectId === current.id ? settings : null;
  const visibleTemplates = current && templatesProjectId === current.id ? templates : [];
  const installSnippet = visibleSettings?.publicKey
    ? trackingInstallSnippet(appOrigin, visibleSettings.publicKey)
    : null;

  const loadSettings = useCallback(async (
    projectId: number,
    options: { syncForm: boolean; announce?: boolean } = { syncForm: true },
  ): Promise<ProjectTrackingSettings | null> => {
    const sequence = ++settingsSequence.current;
    setSettingsLoadError(false);
    const { response, body } = await requestJson("/api/tracking/settings");
    const parsed = response?.ok ? parseTrackingSettingsResponse(body) : null;
    if (sequence !== settingsSequence.current || currentProjectIdRef.current !== projectId) return null;
    if (!parsed) {
      setSettingsLoadError(true);
      if (options.announce) {
        setFeedback({ kind: "error", text: trackingSettingsErrorMessage(responseError(response, body)) });
      }
      return null;
    }
    setSettings(parsed);
    setSettingsProjectId(projectId);
    setSettingsLoadError(false);
    if (options.syncForm) {
      setSiteOrigin(parsed.siteOrigin ?? "");
      setAttributionWindowDays(parsed.attributionWindowDays);
      setSettingsDirty(false);
      setOriginError(null);
      setWindowError(null);
    }
    if (options.announce) {
      setFeedback(parsed.status === "active"
        ? { kind: "success", text: "Подключение подтверждено сервером." }
        : parsed.status === "paused"
          ? { kind: "info", text: "Трекер приостановлен. Переходы считаются, новые события сайта не принимаются." }
          : { kind: "info", text: parsed.signalReceivedAt
            ? "Сигнал от сайта получен. Для заявок ещё нужно подтвердить домен проверочным файлом."
            : "Подключение ожидает подтверждения домена и сигнала от сайта." });
    }
    return parsed;
  }, []);

  const loadTemplates = useCallback(async (projectId: number, announce = false) => {
    const sequence = ++templatesSequence.current;
    setTemplatesLoadError(false);
    const { response, body } = await requestJson("/api/tracking/templates");
    const parsed = response?.ok ? parseUtmTemplatesResponse(body) : null;
    if (sequence !== templatesSequence.current || currentProjectIdRef.current !== projectId) return null;
    if (!parsed) {
      setTemplatesLoadError(true);
      if (announce) {
        setFeedback({ kind: "error", text: trackingSettingsErrorMessage(responseError(response, body)) });
      }
      return null;
    }
    setTemplates(sortTemplates(parsed));
    setTemplatesProjectId(projectId);
    setTemplatesLoadError(false);
    return parsed;
  }, []);

  useEffect(() => {
    let cancelled = false;
    const projectId = current?.id ?? null;
    queueMicrotask(() => {
      if (cancelled) return;
      settingsSequence.current += 1;
      templatesSequence.current += 1;
      setSettings(null);
      setSettingsProjectId(null);
      setTemplates([]);
      setTemplatesProjectId(null);
      setSettingsLoadError(false);
      setTemplatesLoadError(false);
      setFeedback(null);
      setCopied(false);
      setBusyKey(null);
      setDeleteTemplate(null);
      setEditingTemplateId(null);
      setTemplateName("");
      setTemplateValues({ ...EMPTY_TEMPLATE_VALUES });
      setTemplateNameError(null);
      setTemplateValuesError(null);
      if (projectId == null) {
        return;
      }
      void loadSettings(projectId, { syncForm: true });
      void loadTemplates(projectId);
    });
    return () => {
      cancelled = true;
      settingsSequence.current += 1;
      templatesSequence.current += 1;
    };
  }, [current?.id, loadSettings, loadTemplates]);

  const windowOptions = useMemo(() => {
    return Array.from(new Set([7, 14, 30, 60, 90, attributionWindowDays])).sort((a, b) => a - b);
  }, [attributionWindowDays]);

  const resetTemplateForm = useCallback(() => {
    setEditingTemplateId(null);
    setTemplateName("");
    setTemplateValues({ ...EMPTY_TEMPLATE_VALUES });
    setTemplateNameError(null);
    setTemplateValuesError(null);
    setTemplateFieldErrors({});
  }, []);

  const saveSettings = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!current || !visibleSettings || !canManage || busyKey) return;
    const error = siteOriginError(siteOrigin);
    if (error) {
      setOriginError(error);
      originRef.current?.focus();
      return;
    }
    if (!Number.isSafeInteger(attributionWindowDays) || attributionWindowDays < 1 || attributionWindowDays > 90) {
      setWindowError(trackingSettingsErrorMessage("invalid_window"));
      return;
    }
    const projectId = current.id;
    setBusyKey("settings-save");
    setFeedback(null);
    const { response, body } = await requestJson("/api/tracking/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        siteOrigin: siteOrigin.trim(),
        attributionWindowDays,
        expectedVersion: visibleSettings.version,
      }),
    });
    if (currentProjectIdRef.current !== projectId) return;
    const parsed = response?.ok ? parseTrackingSettingsResponse(body) : null;
    if (parsed) {
      setSettings(parsed);
      setSettingsProjectId(projectId);
      setSiteOrigin(parsed.siteOrigin ?? "");
      setAttributionWindowDays(parsed.attributionWindowDays);
      setSettingsDirty(false);
      setOriginError(null);
      setWindowError(null);
      setFeedback(parsed.status === "active"
        ? { kind: "success", text: "Настройки сохранены. Подключение сайта остаётся подтверждённым." }
        : { kind: "success", text: "Настройки сохранены. Размести проверочный файл на сайте и подтверди домен." });
    } else {
      const code = responseError(response, body);
      if (code === "invalid_origin") {
        const message = trackingSettingsErrorMessage(code);
        setOriginError(message);
        originRef.current?.focus();
      } else if (code === "invalid_window") {
        setWindowError(trackingSettingsErrorMessage(code));
      } else if (code === "version_conflict") {
        await loadSettings(projectId, { syncForm: true });
        setFeedback({ kind: "error", text: trackingSettingsErrorMessage(code) });
      } else {
        setFeedback({ kind: "error", text: trackingSettingsErrorMessage(code) });
      }
    }
    if (currentProjectIdRef.current === projectId) setBusyKey(null);
  };

  const checkConnection = async () => {
    if (!current || !visibleSettings?.publicKey || busyKey || !canManage) return;
    const projectId = current.id;
    setBusyKey("settings-check");
    setFeedback(null);
    const { response, body } = await requestJson("/api/tracking/settings/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedVersion: visibleSettings.version }),
    });
    if (currentProjectIdRef.current !== projectId) return;
    const parsed = response?.ok ? parseTrackingSettingsResponse(body) : null;
    if (parsed) {
      setSettings(parsed);
      setSettingsProjectId(projectId);
      setFeedback(body?.verified === true
        ? { kind: "success", text: "Домен подтверждён. События заявок можно учитывать в аналитике." }
        : { kind: "error", text: "Проверочный файл не найден или его содержимое не совпало. Размести файл и повтори проверку." });
    } else {
      const code = responseError(response, body);
      if (code === "version_conflict") await loadSettings(projectId, { syncForm: !settingsDirty });
      setFeedback({ kind: "error", text: trackingSettingsErrorMessage(code) });
    }
    if (currentProjectIdRef.current === projectId) setBusyKey(null);
  };

  const copyVerificationContent = async () => {
    if (!visibleSettings?.verificationFileContent) return;
    try {
      await navigator.clipboard.writeText(visibleSettings.verificationFileContent);
      setVerificationCopied(true);
      setFeedback({ kind: "success", text: "Содержимое проверочного файла скопировано." });
    } catch {
      setFeedback({ kind: "error", text: "Не удалось скопировать содержимое. Выдели строку и скопируй вручную." });
    }
  };

  const copyPublicKey = async () => {
    if (!visibleSettings?.publicKey) return;
    try {
      await navigator.clipboard.writeText(visibleSettings.publicKey);
      setCopied(true);
      setFeedback({ kind: "success", text: "Открытый ключ скопирован." });
    } catch {
      setFeedback({ kind: "error", text: "Не удалось скопировать ключ. Выдели его в поле и скопируй вручную." });
    }
  };

  const copyInstallSnippet = async () => {
    if (!installSnippet) return;
    try {
      await navigator.clipboard.writeText(installSnippet);
      setInstallCopied(true);
      setFeedback({ kind: "success", text: "Код установки скопирован." });
    } catch {
      setFeedback({ kind: "error", text: "Не удалось скопировать код. Выдели его и скопируй вручную." });
    }
  };

  const editTemplate = (template: ProjectUtmTemplate) => {
    if (!canManage || busyKey) return;
    setEditingTemplateId(template.id);
    setTemplateName(template.name);
    setTemplateValues(valuesForForm(template.values));
    setTemplateNameError(null);
    setTemplateValuesError(null);
    setTemplateFieldErrors({});
    setFeedback(null);
    requestAnimationFrame(() => templateNameRef.current?.focus());
  };

  const saveTemplate = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!current || !canManage || busyKey) return;
    const normalizedName = templateName.normalize("NFC").trim().replace(/\s+/gu, " ");
    if (!normalizedName || normalizedName.length > 120) {
      setTemplateNameError(trackingSettingsErrorMessage("invalid_name"));
      templateNameRef.current?.focus();
      return;
    }
    const editing = editingTemplateId == null
      ? null
      : visibleTemplates.find((template) => template.id === editingTemplateId) ?? null;
    if (editingTemplateId != null && !editing) {
      setFeedback({ kind: "error", text: "Шаблон уже изменён или удалён. Обнови список." });
      await loadTemplates(current.id);
      return;
    }
    const fieldErrors = validateUtmFields(templateValues);
    const firstInvalidField = UTM_FIELDS.find((field) => fieldErrors[field]);
    if (firstInvalidField) {
      setTemplateFieldErrors(fieldErrors);
      setTemplateValuesError(null);
      utmInputRefs.current[firstInvalidField]?.focus();
      return;
    }
    const projectId = current.id;
    const key = editing ? `template-update-${editing.id}` : "template-create";
    setBusyKey(key);
    setFeedback(null);
    const { response, body } = await requestJson(
      editing ? `/api/tracking/templates/${editing.id}` : "/api/tracking/templates",
      {
        method: editing ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: normalizedName,
          values: compactValues(templateValues),
          ...(editing ? { expectedVersion: editing.version } : {}),
        }),
      },
    );
    if (currentProjectIdRef.current !== projectId) return;
    const saved = response?.ok ? parseUtmTemplateResponse(body) : null;
    if (saved) {
      setTemplates((currentTemplates) => sortTemplates(
        editing
          ? currentTemplates.map((template) => template.id === saved.id ? saved : template)
          : [...currentTemplates, saved],
      ));
      setTemplatesProjectId(projectId);
      resetTemplateForm();
      setFeedback({
        kind: "success",
        text: editing ? "Шаблон обновлён." : "Шаблон создан.",
      });
    } else {
      const code = responseError(response, body);
      if (code === "invalid_name" || code === "name_conflict") {
        setTemplateNameError(trackingSettingsErrorMessage(code));
        templateNameRef.current?.focus();
      } else if (code === "invalid_utm") {
        const serverFieldErrors = validateUtmFields(templateValues);
        const firstInvalidField = UTM_FIELDS.find((field) => serverFieldErrors[field]);
        if (firstInvalidField) {
          setTemplateFieldErrors(serverFieldErrors);
          setTemplateValuesError(null);
          utmInputRefs.current[firstInvalidField]?.focus();
        } else {
          setTemplateValuesError(trackingSettingsErrorMessage(code));
          const firstFilledField = UTM_FIELDS.find((field) => templateValues[field].trim()) ?? UTM_FIELDS[0];
          utmInputRefs.current[firstFilledField]?.focus();
        }
      } else if (code === "version_conflict") {
        await loadTemplates(projectId);
        resetTemplateForm();
        setFeedback({ kind: "error", text: trackingSettingsErrorMessage(code) });
      } else {
        setFeedback({ kind: "error", text: trackingSettingsErrorMessage(code) });
      }
    }
    if (currentProjectIdRef.current === projectId) setBusyKey(null);
  };

  const confirmDeleteTemplate = async () => {
    if (!current || !deleteTemplate || !canManage || busyKey) return;
    const projectId = current.id;
    const target = deleteTemplate;
    setBusyKey(`template-delete-${target.id}`);
    setFeedback(null);
    const { response, body } = await requestJson(`/api/tracking/templates/${target.id}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedVersion: target.version }),
    });
    if (currentProjectIdRef.current !== projectId) return;
    const deleted = response?.ok
      && body?.ok === true
      && Number(body.id) === target.id
      && body.archived === true;
    if (deleted) {
      setTemplates((currentTemplates) => currentTemplates.filter((template) => template.id !== target.id));
      if (editingTemplateId === target.id) resetTemplateForm();
      setDeleteTemplate(null);
      setFeedback({ kind: "success", text: `Шаблон «${target.name}» удалён.` });
    } else {
      const code = responseError(response, body);
      if (code === "version_conflict" || code === "not_found") {
        await loadTemplates(projectId);
        setDeleteTemplate(null);
        setFeedback({
          kind: "error",
          text: code === "version_conflict"
            ? trackingSettingsErrorMessage(code)
            : "Шаблон уже удалён. Список обновлён.",
        });
      } else {
        setFeedback({ kind: "error", text: trackingSettingsErrorMessage(code) });
      }
    }
    if (currentProjectIdRef.current === projectId) setBusyKey(null);
  };

  const trackerActive = visibleSettings?.status === "active";
  const settingsUnavailable = Boolean(current && !visibleSettings && !settingsLoadError);
  const templatesUnavailable = Boolean(current && templatesProjectId !== current.id && !templatesLoadError);

  return (
    <>
      <Card as="section" aria-labelledby={titleId} className="overflow-hidden">
        <div className="flex items-start gap-3.5 border-b border-line px-5 py-5 sm:px-7">
          <span aria-hidden className="grid h-10 w-10 shrink-0 place-items-center rounded-sm bg-surface-inset text-text-2">
            <Activity className="h-5 w-5" strokeWidth={1.75} />
          </span>
          <div className="min-w-0">
            <h2 id={titleId} className="text-[17px] font-extrabold tracking-tight text-text">
              Трекинг и UTM-шаблоны
            </h2>
            <p className="mt-1 max-w-2xl text-[14px] leading-relaxed text-text-2 text-pretty">
              Свяжи публикации с переходами и подтверждёнными заявками. Заявки учитываются только после серверного подтверждения домена.
            </p>
          </div>
        </div>

        <div className="px-5 py-6 sm:px-7 sm:py-7">
          {!projects.ready ? (
            <p role="status" className="rounded-sm bg-surface-inset p-4 text-[14px] text-text-2">
              Загружаем проект…
            </p>
          ) : !current ? (
            <div role={projects.error ? "alert" : "status"} className="rounded-sm bg-surface-inset p-4">
              <p className="text-[14px] font-bold text-text">
                {projects.error ? "Не удалось загрузить проект" : "Проект не выбран"}
              </p>
              <p className="mt-1 text-[13px] leading-relaxed text-text-2">
                {projects.error
                  ? "Проверь подключение и обнови список проектов."
                  : "Выбери проект в верхней панели, чтобы открыть его настройки трекинга."}
              </p>
              {projects.error ? (
                <Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => void projects.refresh()}>
                  <RefreshCw className="h-4 w-4" aria-hidden />
                  Обновить проекты
                </Button>
              ) : null}
            </div>
          ) : (
            <div className="space-y-10">
              <section aria-labelledby={`${titleId}-connection`}>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <h3 id={`${titleId}-connection`} className="text-[15px] font-extrabold text-text">
                      Подключение сайта
                    </h3>
                    <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-text-3 text-pretty">
                      Аврора принимает события только с точного адреса сайта и учитывает их в выбранный срок после перехода.
                    </p>
                  </div>
                  {visibleSettings ? (
                    trackerActive ? (
                      <Badge tone="success" className="shrink-0">
                        <Check className="h-3.5 w-3.5" aria-hidden />
                        Трекер подключён
                      </Badge>
                    ) : visibleSettings.status === "paused" ? (
                      <Badge tone="neutral" className="shrink-0">
                        <TriangleAlert className="h-3.5 w-3.5" aria-hidden />
                        Трекер приостановлен
                      </Badge>
                    ) : (
                      <Badge tone="neutral" className="shrink-0">
                        <TriangleAlert className="h-3.5 w-3.5" aria-hidden />
                        {visibleSettings.signalReceivedAt ? "Сигнал получен · домен не подтверждён" : "Домен не подтверждён"}
                      </Badge>
                    )
                  ) : null}
                </div>

                {settingsUnavailable ? (
                  <p role="status" className="mt-4 rounded-sm bg-surface-inset p-4 text-[14px] text-text-2">
                    Загружаем настройки трекинга…
                  </p>
                ) : settingsLoadError && !visibleSettings ? (
                  <div role="alert" className="mt-4 rounded-sm bg-danger-soft p-4">
                    <p className="text-[14px] font-bold text-danger-text">Не удалось загрузить настройки трекинга</p>
                    <p className="mt-1 text-[13px] leading-relaxed text-text-2">Проверь подключение и повтори попытку.</p>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="mt-3"
                      onClick={() => void loadSettings(current.id, { syncForm: true })}
                    >
                      <RefreshCw className="h-4 w-4" aria-hidden />
                      Загрузить снова
                    </Button>
                  </div>
                ) : visibleSettings ? (
                  <>
                    {settingsLoadError ? (
                      <p role="alert" className="mt-4 rounded-sm bg-danger-soft p-3 text-[13px] leading-relaxed text-danger-text">
                        Не удалось обновить статус. Последние сохранённые данные остаются на экране.
                      </p>
                    ) : null}

                    <form noValidate onSubmit={saveSettings} className="mt-5 space-y-4">
                      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(12rem,0.38fr)]">
                        <Field
                          label="Адрес сайта"
                          htmlFor="project-tracking-origin"
                          required
                          hint="Только адрес без пути, например https://example.ru."
                          error={originError ?? undefined}
                          messageId={originMessageId}
                        >
                          <Input
                            ref={originRef}
                            id="project-tracking-origin"
                            name="siteOrigin"
                            type="url"
                            required
                            inputMode="url"
                            autoComplete="url"
                            spellCheck={false}
                            value={siteOrigin}
                            placeholder="https://example.ru"
                            disabled={!canManage || Boolean(busyKey) || projects.switching}
                            aria-invalid={originError ? true : undefined}
                            aria-describedby={originMessageId}
                            onChange={(event) => {
                              setSiteOrigin(event.currentTarget.value);
                              setSettingsDirty(true);
                              if (originError) setOriginError(null);
                            }}
                          />
                        </Field>

                        <Field
                          label="Срок атрибуции"
                          htmlFor="project-tracking-window"
                          hint="Сколько дней после перехода связывать заявку с публикацией."
                          error={windowError ?? undefined}
                          messageId={windowMessageId}
                        >
                          <select
                            id="project-tracking-window"
                            name="attributionWindowDays"
                            className={SELECT_CLASS}
                            value={attributionWindowDays}
                            disabled={!canManage || Boolean(busyKey) || projects.switching}
                            aria-invalid={windowError ? true : undefined}
                            aria-describedby={windowMessageId}
                            onChange={(event) => {
                              setAttributionWindowDays(Number(event.currentTarget.value));
                              setSettingsDirty(true);
                              if (windowError) setWindowError(null);
                            }}
                          >
                            {windowOptions.map((days) => (
                              <option key={days} value={days}>{days} дней</option>
                            ))}
                          </select>
                        </Field>
                      </div>

                      {!canManage ? (
                        <p className="rounded-sm bg-surface-inset p-3 text-[13px] leading-relaxed text-text-2">
                          Настройки доступны для просмотра. Изменить их может владелец проекта.
                        </p>
                      ) : (
                        <Button type="submit" variant="brand" loading={busyKey === "settings-save"} disabled={Boolean(busyKey) || projects.switching}>
                          Сохранить подключение
                        </Button>
                      )}
                    </form>

                    {visibleSettings.publicKey ? (
                      <div className="mt-6 rounded-sm bg-surface-inset p-4 sm:p-5">
                        {visibleSettings.verificationFileContent ? (
                          <div className="mb-6 space-y-3">
                            <div>
                              <h4 className="text-[14px] font-bold text-text">Подтверждение домена</h4>
                              <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-text-3 text-pretty">
                                Создай файл <code className="break-all">{visibleSettings.verificationFilePath}</code> на указанном сайте. В файле должна быть только строка ниже — без пробелов и переноса строки.
                              </p>
                            </div>
                            <div className="flex min-w-0 flex-col gap-2 sm:flex-row">
                              <Input
                                value={visibleSettings.verificationFileContent}
                                readOnly
                                aria-label="Содержимое проверочного файла"
                                className="min-w-0 font-mono text-base sm:text-[13px]"
                                onFocus={(event) => event.currentTarget.select()}
                              />
                              <Button type="button" variant="outline" className="shrink-0" onClick={() => void copyVerificationContent()}>
                                <Clipboard className="h-4 w-4" aria-hidden />
                                {verificationCopied ? "Скопировано" : "Скопировать строку"}
                              </Button>
                            </div>
                            {canManage ? (
                              <Button
                                type="button"
                                variant="outline"
                                loading={busyKey === "settings-check"}
                                disabled={Boolean(busyKey) || projects.switching}
                                onClick={() => void checkConnection()}
                              >
                                <RefreshCw className="h-4 w-4" aria-hidden />
                                Подтвердить домен
                              </Button>
                            ) : null}
                          </div>
                        ) : null}
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                          <div className="min-w-0">
                            <h4 className="text-[14px] font-bold text-text">Открытый ключ проекта</h4>
                            <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-text-3 text-pretty">
                              Его можно размещать в коде сайта. Секретные ключи здесь не показываются.
                            </p>
                          </div>
                          <p className="shrink-0 text-[12px] tabular-nums text-text-3">
                            Последний сигнал: <time dateTime={visibleSettings.signalReceivedAt ?? undefined}>{formatDateTime(visibleSettings.signalReceivedAt)}</time>
                          </p>
                        </div>
                        <div className="mt-3 flex min-w-0 flex-col gap-2 sm:flex-row">
                          <Input
                            value={visibleSettings.publicKey}
                            readOnly
                            aria-label="Открытый ключ проекта"
                            className="min-w-0 font-mono text-base sm:text-[13px]"
                            onFocus={(event) => event.currentTarget.select()}
                          />
                          <Button type="button" variant="outline" className="shrink-0" onClick={() => void copyPublicKey()}>
                            <Clipboard className="h-4 w-4" aria-hidden />
                            {copied ? "Скопировано" : "Скопировать ключ"}
                          </Button>
                        </div>
                        {installSnippet ? (
                          <div className="mt-6 space-y-3">
                            <div>
                              <h4 className="text-[14px] font-bold text-text">Код для сайта</h4>
                              <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-text-3 text-pretty">
                                Добавь этот тег в &lt;head&gt; страниц с формой. Он передаст сигнал установки, но не заменяет подтверждение домена.
                              </p>
                            </div>
                            <pre className="max-w-full overflow-x-auto rounded-xs bg-surface px-3 py-3 text-[12px] leading-relaxed text-text">
                              <code>{installSnippet}</code>
                            </pre>
                            <Button type="button" variant="outline" onClick={() => void copyInstallSnippet()}>
                              <Clipboard className="h-4 w-4" aria-hidden />
                              {installCopied ? "Код скопирован" : "Скопировать код установки"}
                            </Button>
                            <p className="max-w-2xl text-[13px] leading-relaxed text-text-3 text-pretty">
                              При открытии или отправке формы вызови событие с постоянным номером заявки:
                            </p>
                            <code className="block max-w-full overflow-x-auto rounded-xs bg-surface px-3 py-3 text-[12px] leading-relaxed text-text">
                              window.AuroraTracking.track(&quot;form_submit&quot;, &quot;form:12345678&quot;);
                            </code>
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </>
                ) : null}
              </section>

              <section aria-labelledby={`${titleId}-templates`}>
                <div className="flex items-start gap-3">
                  <span aria-hidden className="mt-0.5 text-text-3">
                    <Link2 className="h-5 w-5" strokeWidth={1.75} />
                  </span>
                  <div className="min-w-0">
                    <h3 id={`${titleId}-templates`} className="text-[15px] font-extrabold text-text">
                      UTM-шаблоны
                    </h3>
                    <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-text-3 text-pretty">
                      Сохрани повторяющиеся метки проекта, чтобы не собирать их заново для каждой публикации.
                    </p>
                  </div>
                </div>

                {templatesLoadError ? (
                  <div role="alert" className="mt-4 rounded-sm bg-danger-soft p-4">
                    <p className="text-[14px] font-bold text-danger-text">Не удалось загрузить UTM-шаблоны</p>
                    <p className="mt-1 text-[13px] leading-relaxed text-text-2">
                      Сохранённые шаблоны пока недоступны. Новые данные не потеряны.
                    </p>
                    <Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => void loadTemplates(current.id, true)}>
                      <RefreshCw className="h-4 w-4" aria-hidden />
                      Загрузить снова
                    </Button>
                  </div>
                ) : templatesUnavailable ? (
                  <p role="status" className="mt-4 rounded-sm bg-surface-inset p-4 text-[14px] text-text-2">
                    Загружаем UTM-шаблоны…
                  </p>
                ) : visibleTemplates.length === 0 ? (
                  <div role="status" className="mt-4 rounded-sm bg-surface-inset p-4">
                    <p className="text-[14px] font-bold text-text">Шаблонов пока нет</p>
                    <p className="mt-1 text-[13px] leading-relaxed text-text-2">
                      Создай первый шаблон по форме ниже, чтобы применять метки в Композиторе.
                    </p>
                  </div>
                ) : (
                  <ul className="mt-4 divide-y divide-line" aria-label="UTM-шаблоны проекта">
                    {visibleTemplates.map((template) => {
                      const entries = UTM_FIELDS
                        .map((field) => [field, template.values[field]] as const)
                        .filter((entry): entry is readonly [UtmField, string] => Boolean(entry[1]));
                      return (
                        <li key={template.id} className="py-4 first:pt-0 last:pb-0">
                          <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                            <div className="min-w-0 flex-1">
                              <p className="break-words text-[14px] font-bold text-text">{template.name}</p>
                              {entries.length ? (
                                <dl className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[12px] leading-relaxed text-text-3">
                                  {entries.map(([field, value]) => (
                                    <div key={field} className="min-w-0 break-all">
                                      <dt className="inline font-semibold">{field}: </dt>
                                      <dd className="inline">{value}</dd>
                                    </div>
                                  ))}
                                </dl>
                              ) : (
                                <p className="mt-1 text-[12px] text-text-3">Метки не заполнены</p>
                              )}
                              <p className="mt-2 text-[12px] tabular-nums text-text-3">
                                Обновлён <time dateTime={template.updatedAt}>{formatDateTime(template.updatedAt)}</time>
                              </p>
                            </div>
                            {canManage ? (
                              <div className="flex flex-wrap gap-2">
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  disabled={Boolean(busyKey) || projects.switching}
                                  onClick={() => editTemplate(template)}
                                >
                                  <Pencil className="h-4 w-4" aria-hidden />
                                  Изменить
                                </Button>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  className="text-danger-text"
                                  disabled={Boolean(busyKey) || projects.switching}
                                  onClick={() => setDeleteTemplate(template)}
                                >
                                  <Trash2 className="h-4 w-4" aria-hidden />
                                  Удалить
                                </Button>
                              </div>
                            ) : null}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}

                {canManage ? (
                  <form noValidate onSubmit={saveTemplate} className="mt-7 rounded-sm bg-surface-inset p-4 sm:p-5">
                    <h4 className="text-[14px] font-bold text-text">
                      {editingTemplateId == null ? "Создать шаблон" : "Изменить шаблон"}
                    </h4>
                    <p className="mt-1 text-[13px] leading-relaxed text-text-3">
                      Не добавляй в метки имена, телефоны и электронную почту.
                    </p>
                    <div className="mt-4">
                      <Field
                        label="Название шаблона"
                        htmlFor="project-utm-template-name"
                        required
                        hint="Например: Telegram — банкротство бизнеса."
                        error={templateNameError ?? undefined}
                        messageId={templateNameMessageId}
                      >
                        <Input
                          ref={templateNameRef}
                          id="project-utm-template-name"
                          name="templateName"
                          value={templateName}
                          maxLength={120}
                          placeholder="Telegram — банкротство бизнеса"
                          disabled={Boolean(busyKey) || projects.switching}
                          aria-invalid={templateNameError ? true : undefined}
                          aria-describedby={templateNameMessageId}
                          onChange={(event) => {
                            setTemplateName(event.currentTarget.value);
                            if (templateNameError) setTemplateNameError(null);
                          }}
                        />
                      </Field>
                    </div>
                    <fieldset className="mt-5" aria-describedby={templateValuesMessageId}>
                      <legend className="text-[13px] font-semibold text-text-2">Метки</legend>
                      <div className="mt-3 grid gap-4 sm:grid-cols-2">
                        {UTM_FIELDS.map((field) => {
                          const copy = UTM_FIELD_COPY[field];
                          return (
                            <Field
                              key={field}
                              label={`${copy.label} (${field})`}
                              htmlFor={`project-utm-${field}`}
                              hint={copy.hint}
                              error={templateFieldErrors[field]}
                              messageId={`${templateValuesMessageId}-${field}`}
                            >
                              <Input
                                ref={(element) => {
                                  if (element) utmInputRefs.current[field] = element;
                                  else delete utmInputRefs.current[field];
                                }}
                                id={`project-utm-${field}`}
                                name={field}
                                value={templateValues[field]}
                                maxLength={160}
                                autoComplete="off"
                                spellCheck={false}
                                placeholder={copy.placeholder}
                                disabled={Boolean(busyKey) || projects.switching}
                                aria-invalid={templateFieldErrors[field] ? true : undefined}
                                aria-describedby={`${templateValuesMessageId}-${field}`}
                                onChange={(event) => {
                                  const value = event.currentTarget.value;
                                  setTemplateValues((currentValues) => ({
                                    ...currentValues,
                                    [field]: value,
                                  }));
                                  if (templateValuesError) setTemplateValuesError(null);
                                  if (templateFieldErrors[field]) {
                                    setTemplateFieldErrors((currentErrors) => ({
                                      ...currentErrors,
                                      [field]: undefined,
                                    }));
                                  }
                                }}
                              />
                            </Field>
                          );
                        })}
                      </div>
                      <p
                        id={templateValuesMessageId}
                        role={templateValuesError ? "alert" : undefined}
                        className={cn(
                          "mt-3 text-[13px] leading-relaxed",
                          templateValuesError ? "font-medium text-danger-text" : "text-text-3",
                        )}
                      >
                        {templateValuesError ?? "Все поля необязательные; значения ограничены 160 символами."}
                      </p>
                    </fieldset>
                    <div className="mt-5 flex flex-wrap gap-2">
                      <Button
                        type="submit"
                        variant="outline"
                        loading={busyKey === "template-create" || busyKey?.startsWith("template-update-")}
                        disabled={Boolean(busyKey) || projects.switching}
                      >
                        {editingTemplateId == null ? "Создать шаблон" : "Сохранить шаблон"}
                      </Button>
                      {editingTemplateId != null ? (
                        <Button type="button" variant="ghost" disabled={Boolean(busyKey)} onClick={resetTemplateForm}>
                          Отменить изменение
                        </Button>
                      ) : null}
                    </div>
                  </form>
                ) : (
                  <p className="mt-5 rounded-sm bg-surface-inset p-3 text-[13px] leading-relaxed text-text-2">
                    Создавать, изменять и удалять шаблоны может владелец проекта.
                  </p>
                )}
              </section>
            </div>
          )}

          <div
            aria-live="polite"
            aria-atomic="true"
            className={cn(
              "mt-5 min-h-5 text-[13px] leading-relaxed",
              feedback?.kind === "error"
                ? "font-medium text-danger-text"
                : feedback?.kind === "success"
                  ? "font-medium text-success-text"
                  : "text-text-2",
            )}
          >
            {feedback?.text ?? ""}
          </div>
        </div>
      </Card>

      <ConfirmDialog
        open={deleteTemplate !== null}
        title="Удалить UTM-шаблон?"
        description={deleteTemplate
          ? `Шаблон «${deleteTemplate.name}» исчезнет из списка. Уже сохранённые ссылки и публикации не изменятся.`
          : "Шаблон исчезнет из списка."}
        confirmLabel="Удалить шаблон"
        busy={Boolean(deleteTemplate && busyKey === `template-delete-${deleteTemplate.id}`)}
        onCancel={() => {
          if (!busyKey) setDeleteTemplate(null);
        }}
        onConfirm={() => void confirmDeleteTemplate()}
      />
    </>
  );
}
