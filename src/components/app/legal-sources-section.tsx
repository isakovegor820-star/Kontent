"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ExternalLink,
  KeyRound,
  RefreshCw,
  Rss,
  Scale,
  ShieldCheck,
  Unplug,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge, Card, Field, Input } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";

type PublicSource = {
  id: string;
  title: string;
  url: string;
  description: string;
  language: string;
  category: "Юридические источники";
  access: "public_rss";
};

type Provider = {
  id: string;
  label: string;
  kind: "official_api" | "licensed_integration" | "vendor_export" | "user_file";
  licenseNotice: string | null;
  capabilities: string[];
};

type Connection = {
  id: number;
  providerId: string;
  providerLabel: string;
  kind: Provider["kind"];
  status: "connected" | "invalid" | "expired" | "disconnected";
  subscriptionStatus: "active" | "trial" | "expired" | "inactive" | "unknown";
  accountLabel: string | null;
  tokenExpiresAt: string | null;
  lastSyncAt: string | null;
  lastHealthAt: string | null;
  lastError: { code: string; message: string } | null;
};

type LegalSourcesResponse = {
  ok?: boolean;
  error?: string;
  requestId?: string;
  paidIntegrationsStatus?: "available" | "not_configured";
  publicSources?: PublicSource[];
  providers?: Provider[];
  connections?: Connection[];
  fragmentCounts?: Partial<Record<"law" | "case" | "commentary" | "document", number>>;
  retryable?: boolean;
};

type LegalAction = "validate" | "sync" | "health" | "disconnect";

const KIND_LABEL: Record<Provider["kind"], string> = {
  official_api: "Официальное подключение",
  licensed_integration: "Лицензионная интеграция",
  vendor_export: "Разрешённая выгрузка",
  user_file: "Файлы пользователя",
};

const STATUS_LABEL: Record<Connection["status"], string> = {
  connected: "Подключён",
  invalid: "Нужна проверка",
  expired: "Доступ истёк",
  disconnected: "Отключён",
};

const SUBSCRIPTION_LABEL: Record<Connection["subscriptionStatus"], string> = {
  active: "Подписка активна",
  trial: "Пробный доступ",
  expired: "Подписка истекла",
  inactive: "Подписка неактивна",
  unknown: "Статус подписки неизвестен",
};

function requestKey(prefix: string) {
  return `${prefix}:${globalThis.crypto.randomUUID()}`;
}

function formatDate(value: string | null) {
  if (!value) return "Нет данных";
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium", timeStyle: "short" }).format(date)
    : "Нет данных";
}

function errorText(code?: string) {
  switch (code) {
    case "not_configured": return "Официальная интеграция пока не настроена на сервере.";
    case "provider_credentials_rejected": return "Сервис отклонил токен доступа. Создай новый токен в официальном кабинете сервиса.";
    case "subscription_inactive": return "Подписка провайдера неактивна. Проверь её в официальном кабинете.";
    case "provider_rate_limited": return "Провайдер временно ограничил запросы. Повтори позже — тот же запрос не создаст дубль.";
    case "provider_timeout": return "Провайдер не ответил вовремя. Повтори запрос с тем же ID.";
    case "operation_in_progress": return "Этот запрос уже выполняется. Обнови статус через несколько секунд.";
    case "forbidden_credential_field": return "Пароли и данные браузерной сессии принимать нельзя. Используй только официальный токен доступа.";
    case "credential_unavailable": return "Зашифрованный токен недоступен. Подключи источник заново.";
    case "idempotency_conflict": return "Номер запроса уже использован с другими данными. Обнови страницу и повтори действие.";
    default: return "Не удалось выполнить действие. Проверь соединение и повтори попытку.";
  }
}

function toneForConnection(connection: Connection): "success" | "danger" | "neutral" {
  return connection.status === "connected"
    ? "success"
    : connection.status === "invalid" || connection.status === "expired"
      ? "danger"
      : "neutral";
}

export function LegalSourcesSection({ className }: { className?: string }) {
  const [state, setState] = useState<LegalSourcesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [providerId, setProviderId] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [requestId, setRequestId] = useState("");
  const [confirmDisconnectId, setConfirmDisconnectId] = useState<number | null>(null);
  const connectKey = useRef("");
  const actionKeys = useRef(new Map<string, string>());

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/legal-sources", { cache: "no-store" });
      const body = (await response.json().catch(() => null)) as LegalSourcesResponse | null;
      if (!response.ok || !body?.ok) {
        setRequestId(body?.requestId || response.headers.get("x-request-id") || "неизвестен");
        throw new Error(body?.error || "load_failed");
      }
      setState(body);
      const firstConnectable = body.providers?.find((provider) =>
        (provider.kind === "official_api" || provider.kind === "licensed_integration")
        && provider.capabilities.includes("connect"),
      );
      setProviderId((current) => current || firstConnectable?.id || "");
      setRequestId(body.requestId || "");
    } catch (loadError) {
      setError(errorText((loadError as Error).message));
    } finally {
      setLoading(false);
    }
  }, []);

  /* eslint-disable react-hooks/set-state-in-effect -- load the authoritative server integration state on mount */
  useEffect(() => {
    void load();
  }, [load]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const connect = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!providerId || !token.trim() || busy) return;
    const key = connectKey.current || requestKey("legal-connect");
    connectKey.current = key;
    setBusy("connect");
    setMessage("");
    setError("");
    try {
      const response = await fetch("/api/legal-sources/connections", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key },
        body: JSON.stringify({ requestKey: key, providerId, token }),
      });
      const body = (await response.json().catch(() => null)) as LegalSourcesResponse | null;
      const correlation = body?.requestId || response.headers.get("x-request-id") || "неизвестен";
      setRequestId(correlation);
      if (!response.ok || !body?.ok) {
        if (!body?.retryable) connectKey.current = "";
        throw new Error(body?.error || "connect_failed");
      }
      connectKey.current = "";
      setToken("");
      setMessage("Юридический источник подключён. Токен сохранён в зашифрованном виде.");
      await load();
    } catch (connectError) {
      setError(errorText((connectError as Error).message));
    } finally {
      setBusy("");
    }
  };

  const runAction = async (connection: Connection, action: LegalAction) => {
    if (busy) return;
    const mapKey = `${connection.id}:${action}`;
    const key = actionKeys.current.get(mapKey) || requestKey(`legal-${action}`);
    actionKeys.current.set(mapKey, key);
    setBusy(mapKey);
    setMessage("");
    setError("");
    try {
      const response = await fetch(`/api/legal-sources/connections/${connection.id}/actions`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key },
        body: JSON.stringify({ requestKey: key, action }),
      });
      const body = (await response.json().catch(() => null)) as LegalSourcesResponse | null;
      const correlation = body?.requestId || response.headers.get("x-request-id") || "неизвестен";
      setRequestId(correlation);
      if (!response.ok || !body?.ok) {
        if (!body?.retryable && body?.error !== "operation_in_progress") actionKeys.current.delete(mapKey);
        throw new Error(body?.error || "action_failed");
      }
      actionKeys.current.delete(mapKey);
      setConfirmDisconnectId(null);
      setMessage(action === "sync"
        ? "Синхронизация завершена. Каждый фрагмент сохранён с источником и датой."
        : action === "disconnect"
          ? "Юридический источник отключён, зашифрованный токен удалён."
          : "Статус юридического источника обновлён.");
      await load();
    } catch (actionError) {
      setError(errorText((actionError as Error).message));
    } finally {
      setBusy("");
    }
  };

  const providers = state?.providers ?? [];
  const tokenProviders = providers.filter((provider) =>
    (provider.kind === "official_api" || provider.kind === "licensed_integration")
    && provider.capabilities.includes("connect"),
  );
  const connections = state?.connections ?? [];
  const publicSources = state?.publicSources ?? [];

  return (
    <section className={cn("space-y-6", className)} aria-labelledby="legal-sources-title">
      <Card className="overflow-hidden">
        <div className="flex items-start gap-3.5 border-b border-line px-6 py-5 sm:px-7">
          <span aria-hidden className="grid h-10 w-10 shrink-0 place-items-center rounded-sm bg-surface-inset text-text-2">
            <Scale className="h-5 w-5" strokeWidth={1.75} />
          </span>
          <div className="min-w-0">
            <h2 id="legal-sources-title" className="text-[17px] font-extrabold tracking-tight text-text">
              Юридические источники
            </h2>
            <p className="mt-1 text-[14px] leading-relaxed text-text-2">
              Публичные ленты доступны без входа. Платные базы подключаются только через официальное подключение, разрешённую выгрузку, пользовательские файлы или лицензионную интеграцию.
            </p>
          </div>
        </div>

        <div className="space-y-8 px-6 py-6 sm:px-7 sm:py-7">
          <div>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-[15px] font-bold text-text">Публичные RSS</h3>
                <p className="mt-1 text-[13px] text-text-3">Без паролей, данных браузерной сессии и доступа к закрытому кабинету.</p>
              </div>
              <Badge tone="success"><Rss className="h-3.5 w-3.5" aria-hidden />Публичный доступ</Badge>
            </div>
            {loading ? (
              <p role="status" className="text-[14px] text-text-2">Загружаем юридические источники…</p>
            ) : publicSources.length ? (
              <ul className="grid gap-3 lg:grid-cols-2">
                {publicSources.map((source) => (
                  <li key={source.id} className="rounded-sm bg-surface-2 p-4 shadow-soft">
                    <div className="flex items-start gap-3">
                      <span aria-hidden className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-info-soft text-brand">
                        <Rss className="h-4.5 w-4.5" strokeWidth={1.75} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-[14px] font-bold text-text">{source.title}</p>
                        <p className="mt-1 text-[13px] leading-relaxed text-text-2">{source.description}</p>
                        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2">
                          <a
                            href={source.url}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex min-h-11 items-center gap-1.5 text-[13px] font-semibold text-brand underline-offset-4 hover:underline focus-visible:rounded-xs focus-visible:ring-4 focus-visible:ring-brand/15"
                          >
                            Открыть публичный RSS <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                          </a>
                          <Link
                            href={`/app/rss?source=${source.id}`}
                            className="inline-flex min-h-11 items-center text-[13px] font-semibold text-text-2 underline-offset-4 hover:text-text hover:underline focus-visible:rounded-xs focus-visible:ring-4 focus-visible:ring-brand/15"
                          >
                            Настроить в RSS
                          </Link>
                        </div>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[14px] text-text-2">Публичные юридические RSS временно недоступны.</p>
            )}
          </div>

          <div>
            <div className="mb-4 flex items-start gap-3">
              <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-success-text" strokeWidth={1.75} aria-hidden />
              <div>
                <h3 className="text-[15px] font-bold text-text">Лицензионные подключения</h3>
                <p className="mt-1 text-[13px] leading-relaxed text-text-3">
                  Аврора не собирает пароль и данные браузерной сессии, не обходит подписку и не считывает закрытый кабинет.
                </p>
              </div>
            </div>

            {!loading && state?.paidIntegrationsStatus === "not_configured" && (
              <div className="rounded-sm bg-surface-inset p-4 text-[13px] leading-relaxed text-text-2">
                Официальные адреса сервисов не настроены. Подключение останется недоступным, пока администратор не добавит подтверждённую лицензионную конфигурацию на сервере.
              </div>
            )}

            {tokenProviders.length > 0 && (
              <form onSubmit={connect} className="mt-4 space-y-4 rounded-sm bg-surface-2 p-4 sm:p-5">
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Провайдер" htmlFor="legal-provider">
                    <select
                      id="legal-provider"
                      value={providerId}
                      onChange={(event) => {
                        setProviderId(event.target.value);
                        connectKey.current = "";
                      }}
                      className="h-12 w-full rounded-xs border border-line bg-surface px-4 text-[15px] text-text focus:border-brand focus:outline-none focus-visible:ring-4 focus-visible:ring-brand/15"
                    >
                      {tokenProviders.map((provider) => (
                        <option key={provider.id} value={provider.id}>
                          {provider.label} · {KIND_LABEL[provider.kind]}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field
                    label="Официальный токен доступа"
                    htmlFor="legal-api-token"
                    hint="Создай токен доступа в официальном кабинете сервиса. Не вставляй пароль или данные браузерной сессии."
                  >
                    <Input
                      id="legal-api-token"
                      name="legal-api-token"
                      type="password"
                      autoComplete="off"
                      value={token}
                      onChange={(event) => {
                        setToken(event.target.value);
                        connectKey.current = "";
                      }}
                      aria-invalid={Boolean(error) || undefined}
                    />
                  </Field>
                </div>
                <Button type="submit" variant="outline" loading={busy === "connect"}>
                  <KeyRound className="h-4 w-4" aria-hidden />
                  Подключить официальный сервис
                </Button>
              </form>
            )}
          </div>

          {connections.length > 0 && (
            <div>
              <h3 className="mb-4 text-[15px] font-bold text-text">Подключённые источники</h3>
              <ul className="space-y-3">
                {connections.map((connection) => (
                  <li key={connection.id} className="rounded-sm bg-surface-2 p-4 sm:p-5">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="font-bold text-text">{connection.providerLabel}</p>
                          <Badge tone={toneForConnection(connection)}>{STATUS_LABEL[connection.status]}</Badge>
                        </div>
                        <p className="mt-1 text-[13px] text-text-3">
                          {KIND_LABEL[connection.kind]} · {SUBSCRIPTION_LABEL[connection.subscriptionStatus]}
                        </p>
                      </div>
                      {connection.accountLabel && <Badge tone="neutral">{connection.accountLabel}</Badge>}
                    </div>

                    <dl className="mt-4 grid gap-3 text-[13px] sm:grid-cols-3">
                      <div><dt className="text-text-3">Токен действует до</dt><dd className="mt-1 font-semibold text-text">{formatDate(connection.tokenExpiresAt)}</dd></div>
                      <div><dt className="text-text-3">Последняя синхронизация</dt><dd className="mt-1 font-semibold text-text">{formatDate(connection.lastSyncAt)}</dd></div>
                      <div><dt className="text-text-3">Последняя проверка</dt><dd className="mt-1 font-semibold text-text">{formatDate(connection.lastHealthAt)}</dd></div>
                    </dl>

                    {connection.lastError && (
                      <p role="alert" className="mt-4 rounded-xs bg-danger-soft px-3 py-2 text-[13px] text-danger-text">
                        {connection.lastError.message} Код: {connection.lastError.code}
                      </p>
                    )}

                    <div className="mt-4 flex flex-wrap gap-3">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        loading={busy === `${connection.id}:health`}
                        onClick={() => void runAction(connection, "health")}
                      >
                        <ShieldCheck className="h-4 w-4" aria-hidden />Проверить статус
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        loading={busy === `${connection.id}:sync`}
                        disabled={connection.status === "disconnected"}
                        onClick={() => void runAction(connection, "sync")}
                      >
                        <RefreshCw className="h-4 w-4" aria-hidden />Синхронизировать
                      </Button>
                      {connection.status !== "disconnected" && confirmDisconnectId !== connection.id && (
                        <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmDisconnectId(connection.id)}>
                          <Unplug className="h-4 w-4" aria-hidden />Отключить источник
                        </Button>
                      )}
                    </div>

                    {confirmDisconnectId === connection.id && (
                      <div role="group" aria-label={`Подтверждение отключения ${connection.providerLabel}`} className="mt-4 rounded-sm bg-danger-soft p-4">
                        <p className="text-[13px] leading-relaxed text-danger-text">
                          Отключить источник и удалить его зашифрованный токен? Уже сохранённые фрагменты останутся с указанием происхождения.
                        </p>
                        <div className="mt-3 flex flex-wrap gap-3">
                          <Button type="button" size="sm" variant="outline" onClick={() => setConfirmDisconnectId(null)}>Отменить</Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="danger"
                            loading={busy === `${connection.id}:disconnect`}
                            onClick={() => void runAction(connection, "disconnect")}
                          >
                            Отключить источник
                          </Button>
                        </div>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="rounded-sm bg-surface-inset p-4">
            <p className="text-[13px] font-semibold text-text">Юридические данные хранятся отдельно</p>
            <p className="mt-1 text-[13px] leading-relaxed text-text-3">
              Типы: нормативный акт, судебное дело, комментарий и документ. У каждого фрагмента сохраняются источник, дата, актуальность и ссылка.
            </p>
          </div>

          <div aria-live="polite" aria-atomic="true" className="min-h-5 text-[13px]">
            {message && <p role="status" className="font-medium text-success-text">{message}</p>}
            {error && (
              <p role="alert" className="font-medium text-danger-text">
                {error} {requestId && <>Номер запроса: <span className="font-mono">{requestId}</span>.</>}
              </p>
            )}
          </div>
        </div>
      </Card>
    </section>
  );
}
