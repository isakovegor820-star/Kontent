"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown, Copy, Link2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Field, Input } from "@/components/ui/primitives";
import type { DraftTrackingSelection } from "@/lib/draft-types";
import {
  validateUtmFields,
  type UtmFieldErrors,
} from "@/lib/tracking-field-validation";
import {
  normalizeTrackingDestination,
  normalizeUtmValues,
  UTM_FIELDS,
  type UtmField,
  type UtmValues,
} from "@/lib/utm";
import { cn } from "@/lib/utils";

export type ComposerTrackingValue = {
  destination: string;
  utmValues: UtmValues;
  templateId: number | null;
  shortLinkId: number | null;
  shortUrlPath: string | null;
  placement: DraftTrackingSelection["placement"];
};

type UtmTemplate = {
  id: number;
  name: string;
  values: UtmValues;
  version: number;
};

type TrackingSettings = {
  status: "not_connected" | "active" | "paused" | "verification_failed";
  siteOrigin: string | null;
};

type ShortLinkSummary = {
  id: number;
  slug: string;
  status: "active" | "revoked" | "expired";
  version: number;
  expiresAt: string | null;
};

export { validateUtmFields } from "@/lib/tracking-field-validation";

export const EMPTY_COMPOSER_TRACKING: ComposerTrackingValue = {
  destination: "",
  utmValues: {},
  templateId: null,
  shortLinkId: null,
  shortUrlPath: null,
  placement: "cta",
};

const SHORT_PATH = /^\/r\/[A-Za-z0-9_-]{20,64}$/u;

export function composerTrackingHasInput(value: ComposerTrackingValue) {
  return Boolean(
    value.destination.trim()
    || value.shortLinkId != null
    || value.shortUrlPath
    || Object.values(value.utmValues).some((item) => item?.trim()),
  );
}

export function composerTrackingDraftSelection(value: ComposerTrackingValue): {
  selection: DraftTrackingSelection | null;
  error: string | null;
} {
  if (!composerTrackingHasInput(value)) return { selection: null, error: null };
  if (!value.destination.trim()) {
    return { selection: null, error: "Укажи страницу перехода или очисти UTM-поля." };
  }
  try {
    if (
      (value.shortLinkId == null && value.shortUrlPath != null)
      || (value.shortLinkId != null && (!value.shortUrlPath || !SHORT_PATH.test(value.shortUrlPath)))
    ) {
      return { selection: null, error: "Создай короткую ссылку заново: сохранённый адрес устарел." };
    }
    return {
      selection: {
        shortLinkId: value.shortLinkId,
        shortUrlPath: value.shortUrlPath,
        destination: normalizeTrackingDestination(value.destination),
        utmValues: normalizeUtmValues(value.utmValues),
        placement: value.placement,
      },
      error: null,
    };
  } catch {
    return {
      selection: null,
      error: "Укажи полный публичный адрес сайта и проверь UTM-поля.",
    };
  }
}

const UTM_LABELS: Record<UtmField, { label: string; example: string }> = {
  utm_source: { label: "Источник", example: "telegram" },
  utm_medium: { label: "Канал", example: "social" },
  utm_campaign: { label: "Кампания", example: "bankruptcy_august" },
  utm_content: { label: "Материал", example: "post_deadlines" },
  utm_term: { label: "Тема", example: "bankruptcy" },
};

const LINK_TTL_OPTIONS = [
  { value: "30", label: "30 дней" },
  { value: "90", label: "90 дней" },
  { value: "365", label: "1 год" },
  { value: "", label: "Без срока" },
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parsedUtm(value: unknown): UtmValues | null {
  if (!isRecord(value)) return null;
  const result: UtmValues = {};
  for (const field of UTM_FIELDS) {
    if (value[field] == null) continue;
    if (typeof value[field] !== "string") return null;
    result[field] = value[field];
  }
  return result;
}

export function parseTrackingTemplates(payload: unknown): UtmTemplate[] | null {
  if (!isRecord(payload) || payload.ok !== true || !Array.isArray(payload.templates)) return null;
  const templates: UtmTemplate[] = [];
  for (const item of payload.templates) {
    if (!isRecord(item)) return null;
    const values = parsedUtm(item.values);
    if (
      !Number.isSafeInteger(item.id) || Number(item.id) <= 0
      || typeof item.name !== "string" || !item.name.trim()
      || !Number.isSafeInteger(item.version) || Number(item.version) <= 0
      || !values
    ) return null;
    templates.push({ id: Number(item.id), name: item.name, values, version: Number(item.version) });
  }
  return templates;
}

export function trackingBuilderError(error: unknown) {
  const code = isRecord(error) && typeof error.error === "string" ? error.error : "network";
  const messages: Record<string, string> = {
    invalid_destination: "Укажи полный адрес публичного сайта, например https://example.ru/page.",
    invalid_utm: "Проверь UTM-поля: в них нельзя добавлять email и телефон.",
    invalid_template: "Шаблон больше недоступен. Выбери другой или заполни поля вручную.",
    idempotency_conflict: "Параметры изменились во время сохранения. Создай ссылку ещё раз.",
    rate_limited: "Слишком много запросов. Подожди и повтори создание ссылки.",
    rate_limit_unavailable: "Ссылка не создана: защита запросов временно недоступна. Повтори позже.",
    access_denied: "Для этого проекта нельзя создавать ссылки.",
    network: "Ссылка не создана. Проверь подключение и повтори попытку.",
  };
  return messages[code] ?? "Ссылка не создана. Проверь адрес и повтори попытку.";
}

function parseShortLink(value: unknown): ShortLinkSummary | null {
  if (!isRecord(value)) return null;
  const id = Number(value.id);
  const version = Number(value.version);
  const status = value.status;
  const expiresAt = value.expiresAt == null ? null : String(value.expiresAt);
  if (
    !Number.isSafeInteger(id) || id <= 0
    || !Number.isSafeInteger(version) || version <= 0
    || typeof value.slug !== "string" || !/^[A-Za-z0-9_-]{20,64}$/u.test(value.slug)
    || (status !== "active" && status !== "revoked" && status !== "expired")
    || (expiresAt != null && Number.isNaN(new Date(expiresAt).getTime()))
  ) return null;
  return { id, version, slug: value.slug, status, expiresAt };
}

export function parseTrackingLinks(payload: unknown): ShortLinkSummary[] | null {
  if (!isRecord(payload) || payload.ok !== true || !Array.isArray(payload.links)) return null;
  const links = payload.links.map(parseShortLink);
  return links.every((link): link is ShortLinkSummary => link !== null) ? links : null;
}

function parseSettings(payload: unknown): TrackingSettings | null {
  if (!isRecord(payload) || payload.ok !== true || !isRecord(payload.tracking)) return null;
  const tracking = payload.tracking;
  if (
    tracking.status !== "not_connected"
    && tracking.status !== "active"
    && tracking.status !== "paused"
    && tracking.status !== "verification_failed"
  ) return null;
  return {
    status: tracking.status,
    siteOrigin: typeof tracking.siteOrigin === "string" ? tracking.siteOrigin : null,
  };
}

function makeRequestKey() {
  return `tracking:link:${crypto.randomUUID()}`;
}

export function TrackingBuilder({
  value = EMPTY_COMPOSER_TRACKING,
  onChange,
  disabled = false,
  validationError,
}: {
  value?: ComposerTrackingValue;
  onChange: (value: ComposerTrackingValue) => void;
  disabled?: boolean;
  validationError?: string;
}) {
  const baseId = useId();
  const destinationRef = useRef<HTMLInputElement>(null);
  const utmRefs = useRef<Partial<Record<UtmField, HTMLInputElement>>>({});
  const requestKey = useRef<string | null>(null);
  const [templates, setTemplates] = useState<UtmTemplate[]>([]);
  const [links, setLinks] = useState<ShortLinkSummary[]>([]);
  const [tracker, setTracker] = useState<TrackingSettings | null>(null);
  const [loadMessage, setLoadMessage] = useState("");
  const [destinationError, setDestinationError] = useState("");
  const [utmErrors, setUtmErrors] = useState<UtmFieldErrors>({});
  const [formError, setFormError] = useState("");
  const [status, setStatus] = useState("");
  const [saving, setSaving] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [ttlDays, setTtlDays] = useState("30");
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setLoadMessage("");
    try {
      const [templatesResponse, settingsResponse, linksResponse] = await Promise.all([
        fetch("/api/tracking/templates", { cache: "no-store" }),
        fetch("/api/tracking/settings", { cache: "no-store" }),
        fetch("/api/tracking/links", { cache: "no-store" }),
      ]);
      const [templatesBody, settingsBody, linksBody] = await Promise.all([
        templatesResponse.json().catch(() => null),
        settingsResponse.json().catch(() => null),
        linksResponse.json().catch(() => null),
      ]);
      const parsedTemplates = templatesResponse.ok ? parseTrackingTemplates(templatesBody) : null;
      const parsedSettings = settingsResponse.ok ? parseSettings(settingsBody) : null;
      const parsedLinks = linksResponse.ok ? parseTrackingLinks(linksBody) : null;
      if (parsedTemplates) setTemplates(parsedTemplates);
      if (parsedSettings) setTracker(parsedSettings);
      if (parsedLinks) setLinks(parsedLinks);
      if (!parsedTemplates || !parsedSettings || !parsedLinks) {
        setLoadMessage("Часть данных не загрузилась. Новую ссылку можно настроить вручную.");
      }
    } catch {
      setLoadMessage("Шаблоны и статус трекера не загрузились. Ссылку можно настроить вручную.");
    }
  }, []);

  useEffect(() => {
    const initialLoad = window.setTimeout(() => void load(), 0);
    const refresh = () => void load();
    window.addEventListener("aurora:project-changed", refresh);
    return () => {
      window.clearTimeout(initialLoad);
      window.removeEventListener("aurora:project-changed", refresh);
    };
  }, [load]);

  const update = (next: Partial<ComposerTrackingValue>) => {
    requestKey.current = null;
    setCopied(false);
    setDestinationError("");
    setFormError("");
    setStatus(value.shortLinkId ? "Параметры изменены. Создай короткую ссылку заново." : "");
    onChange({ ...value, ...next, shortLinkId: null, shortUrlPath: null });
  };

  const selectTemplate = (templateId: number | null) => {
    const template = templates.find((item) => item.id === templateId);
    update({ templateId, utmValues: template?.values ?? {} });
  };

  const createLink = async () => {
    setDestinationError("");
    setUtmErrors({});
    setFormError("");
    setStatus("");
    if (!value.destination.trim()) {
      setDestinationError("Укажи адрес страницы, куда должен перейти читатель.");
      destinationRef.current?.focus();
      return;
    }
    try {
      normalizeTrackingDestination(value.destination);
    } catch {
      setDestinationError("Укажи полный адрес публичного сайта, например https://example.ru/page.");
      destinationRef.current?.focus();
      return;
    }
    const nextUtmErrors = validateUtmFields(value.utmValues);
    const firstInvalidUtm = UTM_FIELDS.find((field) => nextUtmErrors[field]);
    if (firstInvalidUtm) {
      setUtmErrors(nextUtmErrors);
      utmRefs.current[firstInvalidUtm]?.focus();
      return;
    }
    setSaving(true);
    requestKey.current ??= makeRequestKey();
    try {
      const response = await fetch("/api/tracking/links", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": requestKey.current },
        body: JSON.stringify({
          destination: value.destination,
          utmValues: value.utmValues,
          templateId: value.templateId,
          expiresAt: ttlDays
            ? new Date(Date.now() + Number(ttlDays) * 24 * 60 * 60 * 1_000).toISOString()
            : null,
        }),
      });
      const body: unknown = await response.json().catch(() => null);
      const link = response.ok && isRecord(body) && body.ok === true
        ? parseShortLink(body.link)
        : null;
      if (!link) {
        const code = isRecord(body) && typeof body.error === "string" ? body.error : "network";
        if (code === "invalid_destination") {
          setDestinationError(trackingBuilderError(body));
          destinationRef.current?.focus();
        } else if (code === "invalid_utm") {
          const serverUtmErrors = validateUtmFields(value.utmValues);
          const invalidField = UTM_FIELDS.find((field) => serverUtmErrors[field]);
          if (invalidField) {
            setUtmErrors(serverUtmErrors);
            utmRefs.current[invalidField]?.focus();
          } else {
            setFormError(trackingBuilderError(body));
          }
        } else {
          setFormError(trackingBuilderError(body));
        }
        return;
      }
      const shortUrlPath = `/r/${link.slug}`;
      setLinks((current) => [link, ...current.filter((item) => item.id !== link.id)]);
      onChange({ ...value, shortLinkId: link.id, shortUrlPath });
      setStatus(link.expiresAt
        ? `Короткая ссылка действует до ${new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium" }).format(new Date(link.expiresAt))}.`
        : "Короткая ссылка создана без ограничения срока.");
    } catch {
      setFormError(trackingBuilderError({ error: "network" }));
    } finally {
      setSaving(false);
    }
  };

  const copyLink = async () => {
    if (!value.shortUrlPath) return;
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${value.shortUrlPath}`);
      setCopied(true);
      setStatus("Короткая ссылка скопирована.");
    } catch {
      setFormError("Не удалось скопировать ссылку. Выдели адрес и скопируй его вручную.");
    }
  };

  const currentLink = value.shortLinkId == null
    ? null
    : links.find((link) => link.id === value.shortLinkId) ?? null;

  const revokeLink = async () => {
    if (!currentLink || currentLink.status !== "active" || revoking) return;
    setRevoking(true);
    setFormError("");
    try {
      const response = await fetch(`/api/tracking/links/${currentLink.id}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedVersion: currentLink.version }),
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok || !isRecord(body) || body.ok !== true || body.status !== "revoked") {
        setFormError(response.status === 409
          ? "Ссылка уже изменилась. Обнови данные и повтори действие."
          : "Ссылка не отозвана. Проверь подключение и повтори попытку.");
        await load();
        return;
      }
      setLinks((current) => current.map((link) => link.id === currentLink.id
        ? { ...link, status: "revoked", version: Number(body.version) || link.version + 1 }
        : link));
      onChange({ ...value, shortLinkId: null, shortUrlPath: null });
      requestKey.current = null;
      setStatus("Ссылка отозвана. Страница и UTM-поля сохранены — можно создать новую.");
    } catch {
      setFormError("Ссылка не отозвана. Проверь подключение и повтори попытку.");
    } finally {
      setConfirmRevoke(false);
      setRevoking(false);
    }
  };

  const trackerReady = tracker?.status === "active";
  const visibleDestinationError = destinationError || validationError || "";

  return (
    <>
    <details className="group border-block border-line py-1">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-3 rounded-xs px-1 py-2 text-start focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand/15">
        <Link2 className="h-5 w-5 shrink-0 text-text-2" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="block text-[15px] font-semibold text-text">Ссылка и отслеживание</span>
          <span className="block text-[13px] leading-relaxed text-text-3 text-pretty">
            {value.shortUrlPath ? "Короткая ссылка готова" : "UTM, переходы и заявки с сайта"}
          </span>
        </span>
        <ChevronDown className="h-5 w-5 shrink-0 text-text-3 transition-transform duration-200 group-open:rotate-180 motion-reduce:transition-none" aria-hidden="true" />
      </summary>

      <div className="space-y-6 pb-5 pt-3 ps-0 sm:ps-8">
        {loadMessage && <p className="max-w-2xl text-[13px] leading-relaxed text-warning-text">{loadMessage}</p>}

        <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-[minmax(0,1.2fr)_repeat(3,minmax(10rem,0.5fr))]">
          <Field
            label="Страница перехода"
            htmlFor={`${baseId}-destination`}
            required
            error={visibleDestinationError || undefined}
            messageId={`${baseId}-destination-message`}
            hint="Полный публичный адрес страницы консультации или формы."
          >
            <Input
              ref={destinationRef}
              id={`${baseId}-destination`}
              type="url"
              required
              inputMode="url"
              autoComplete="url"
              placeholder="https://example.ru/consultation"
              value={value.destination}
              disabled={disabled || saving}
              aria-invalid={Boolean(visibleDestinationError)}
              aria-describedby={`${baseId}-destination-message`}
              onChange={(event) => update({ destination: event.target.value })}
            />
          </Field>

          <Field label="Шаблон кампании" htmlFor={`${baseId}-template`} hint="Можно продолжить без шаблона.">
            <select
              id={`${baseId}-template`}
              className="h-12 w-full rounded-xs border border-line bg-surface px-4 text-base text-text transition-colors duration-200 hover:border-line-strong focus:border-brand focus:outline-none focus-visible:ring-4 focus-visible:ring-brand/15 sm:text-[15px]"
              value={value.templateId ?? ""}
              disabled={disabled || saving}
              onChange={(event) => selectTemplate(event.target.value ? Number(event.target.value) : null)}
            >
              <option value="">Без шаблона</option>
              {templates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}
            </select>
          </Field>

          <Field label="Где использовать" htmlFor={`${baseId}-placement`} hint="Выбор сохранится с версией поста.">
            <select
              id={`${baseId}-placement`}
              className="h-12 w-full rounded-xs border border-line bg-surface px-4 text-base text-text transition-colors duration-200 hover:border-line-strong focus:border-brand focus:outline-none focus-visible:ring-4 focus-visible:ring-brand/15 sm:text-[15px]"
              value={value.placement}
              disabled={disabled || saving}
              onChange={(event) => update({ placement: event.target.value as ComposerTrackingValue["placement"] })}
            >
              <option value="cta">Призыв к действию</option>
              <option value="post">Текст поста</option>
              <option value="first_comment">Первый комментарий</option>
              <option value="source">Блок источников</option>
            </select>
          </Field>

          <Field label="Срок ссылки" htmlFor={`${baseId}-ttl`} hint="После срока переходы по ссылке закроются.">
            <select
              id={`${baseId}-ttl`}
              className="h-12 w-full rounded-xs border border-line bg-surface px-4 text-base text-text transition-colors duration-200 hover:border-line-strong focus:border-brand focus:outline-none focus-visible:ring-4 focus-visible:ring-brand/15 sm:text-[15px]"
              value={ttlDays}
              disabled={disabled || saving || value.shortLinkId != null}
              onChange={(event) => {
                requestKey.current = null;
                setTtlDays(event.target.value);
              }}
            >
              {LINK_TTL_OPTIONS.map((option) => (
                <option key={option.value || "unlimited"} value={option.value}>{option.label}</option>
              ))}
            </select>
          </Field>
        </div>

        <fieldset className="space-y-3">
          <legend className="text-[13px] font-semibold text-text-2">UTM-метки</legend>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {UTM_FIELDS.map((field) => (
              <Field
                key={field}
                label={UTM_LABELS[field].label}
                htmlFor={`${baseId}-${field}`}
                error={utmErrors[field]}
                messageId={`${baseId}-${field}-message`}
              >
                <Input
                  ref={(element) => {
                    if (element) utmRefs.current[field] = element;
                    else delete utmRefs.current[field];
                  }}
                  id={`${baseId}-${field}`}
                  value={value.utmValues[field] ?? ""}
                  placeholder={UTM_LABELS[field].example}
                  disabled={disabled || saving}
                  aria-invalid={Boolean(utmErrors[field])}
                  aria-describedby={`${baseId}-${field}-message`}
                  onChange={(event) => {
                    setUtmErrors((current) => ({ ...current, [field]: undefined }));
                    update({ utmValues: { ...value.utmValues, [field]: event.target.value } });
                  }}
                />
              </Field>
            ))}
          </div>
        </fieldset>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <Button type="button" variant="outline" loading={saving} disabled={disabled || revoking} onClick={() => void createLink()}>
            Создать короткую ссылку
          </Button>
          {value.shortUrlPath && (
            <div className="flex min-w-0 items-center gap-2">
              <code className="min-w-0 break-all rounded-xs bg-surface-inset px-3 py-2 text-[13px] leading-relaxed text-text">
                {value.shortUrlPath}
              </code>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Скопировать короткую ссылку"
                onClick={() => void copyLink()}
              >
                {copied ? <Check className="h-4 w-4" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
              </Button>
              {currentLink?.status === "active" ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-danger-text"
                  disabled={disabled || saving || revoking}
                  onClick={() => setConfirmRevoke(true)}
                >
                  Отозвать ссылку
                </Button>
              ) : null}
            </div>
          )}
        </div>

        {currentLink && currentLink.status !== "active" ? (
          <p role="alert" className="max-w-2xl rounded-sm bg-danger-soft p-3 text-[13px] leading-relaxed text-danger-text">
            Эта ссылка больше не принимает переходы. Страница и UTM-поля сохранены — создай новую ссылку.
          </p>
        ) : null}

        <p className={cn("max-w-2xl text-[13px] leading-relaxed", trackerReady ? "text-success-text" : "text-text-3")}>
          {trackerReady
            ? `Трекер заявок подключён${tracker?.siteOrigin ? ` к ${tracker.siteOrigin}` : ""}.`
            : "Переходы будут считаться. Заявки появятся в аналитике после подключения трекера сайта."}
        </p>
        <div role="status" aria-live="polite" aria-atomic="true" className="min-h-5 text-[13px] font-medium text-text-2">
          {status}
        </div>
        {formError ? (
          <p role="alert" className="max-w-2xl text-[13px] font-medium leading-relaxed text-danger-text">
            {formError}
          </p>
        ) : null}
      </div>
    </details>
    <ConfirmDialog
      open={confirmRevoke}
      title="Отозвать короткую ссылку?"
      description="Переходы по этой ссылке прекратятся во всех уже опубликованных постах. Страница и UTM-поля останутся в черновике."
      confirmLabel="Отозвать ссылку"
      busy={revoking}
      onCancel={() => {
        if (!revoking) setConfirmRevoke(false);
      }}
      onConfirm={() => void revokeLink()}
    />
    </>
  );
}
