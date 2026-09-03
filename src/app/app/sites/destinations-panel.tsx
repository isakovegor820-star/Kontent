"use client";

import { useCallback, useEffect, useState } from "react";
import { ExternalLink, Globe2, Lock, ShieldCheck, Unlock } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge, Card, Field, Input } from "@/components/ui/primitives";

import { errorMessage, formatDate, requestJson } from "./client";

type Destination = {
  id: number;
  kind: "wordpress" | "site_hosted";
  label: string;
  baseUrl: string;
  credentialState: string;
  status: string;
  hostedSlug: string | null;
  account: { id: number; name: string } | null;
  lastVerifiedAt: string | null;
  lastErrorCode: string | null;
  readyToPublish: boolean;
};

type Props = {
  siteId: number;
  verified: boolean;
  publishingMode: "confirm" | "auto";
  approvedStreak: number;
  autoUnlockStreak: number;
  hostedOrigin: string | null;
  brandName: string | null;
  onChanged: () => void;
};

export function DestinationsPanel({ siteId, verified, publishingMode, approvedStreak, autoUnlockStreak, hostedOrigin, brandName, onChanged }: Props) {
  const [destinations, setDestinations] = useState<Destination[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [wp, setWp] = useState({ baseUrl: "", username: "", appPassword: "" });
  const [brand, setBrand] = useState(brandName || "");

  const load = useCallback(async () => {
    try {
      const { status, body } = await requestJson<{ destinations?: Destination[]; error?: string }>(`/api/sites/${siteId}/destinations`);
      if (status !== 200 || !body.destinations) throw Object.assign(new Error("list_failed"), { code: body.error });
      setDestinations(body.destinations);
      setError(null);
    } catch (caught) {
      setError(errorMessage((caught as { code?: string }).code, "Не удалось загрузить назначения."));
    }
  }, [siteId]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- state changes only after the request settles
  useEffect(() => { void load(); }, [load]);

  const put = useCallback(async (payload: Record<string, unknown>, key: string) => {
    setBusy(key);
    setError(null);
    const { status, body } = await requestJson<{ error?: string; verification?: { reason?: string } }>(`/api/sites/${siteId}/destinations`, { method: "PUT", body: JSON.stringify(payload) });
    setBusy(null);
    if (status >= 400) {
      setError(errorMessage(body.error, body.verification?.reason ? `WordPress: ${body.verification.reason}` : "Не удалось сохранить назначение."));
      return false;
    }
    await load();
    onChanged();
    return true;
  }, [siteId, load, onChanged]);

  const remove = useCallback(async (kind: string) => {
    setBusy(`delete:${kind}`);
    const { status, body } = await requestJson<{ error?: string }>(`/api/sites/${siteId}/destinations?kind=${kind}`, { method: "DELETE" });
    setBusy(null);
    if (status >= 400) setError(errorMessage(body.error, "Не удалось отключить назначение."));
    await load();
    onChanged();
  }, [siteId, load, onChanged]);

  const patchSettings = useCallback(async (payload: Record<string, unknown>, key: string) => {
    setBusy(key);
    setError(null);
    const { status, body } = await requestJson<{ error?: string }>(`/api/sites/${siteId}/settings`, { method: "PATCH", body: JSON.stringify(payload) });
    setBusy(null);
    if (status >= 400) {
      setError(errorMessage(body.error, "Не удалось сохранить настройку."));
      return;
    }
    onChanged();
  }, [siteId, onChanged]);

  const wordpress = destinations.find((item) => item.kind === "wordpress" && item.status !== "disconnected");
  const hosted = destinations.find((item) => item.kind === "site_hosted" && item.status !== "disconnected");
  const unlocked = approvedStreak >= autoUnlockStreak;

  return (
    <div className="space-y-6">
      {error && <p role="alert" className="type-secondary rounded-sm bg-danger-soft p-4 text-danger-text">{error}</p>}
      {!verified && (
        <p className="type-secondary rounded-sm bg-fire-soft p-4 text-fire-text">
          Публикация на сайт открывается после подтверждения владения доменом. Назначения можно настроить заранее.
        </p>
      )}

      <Card className="p-5 sm:p-6">
        <h3 className="type-h3 text-text">Режим публикации</h3>
        <p className="type-secondary mt-1 text-text-2">
          Сейчас: <strong>{publishingMode === "auto" ? "автоматически" : "с подтверждением"}</strong>. Серия одобрений без правок: {approvedStreak} из {autoUnlockStreak}.
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          {publishingMode === "confirm" ? (
            <Button type="button" size="sm" variant={unlocked ? "primary" : "secondary"} disabled={!unlocked || busy === "mode"} onClick={() => patchSettings({ publishingMode: "auto" }, "mode")}>
              {unlocked ? <Unlock className="h-4 w-4" aria-hidden /> : <Lock className="h-4 w-4" aria-hidden />}
              Включить автоматический режим
            </Button>
          ) : (
            <Button type="button" size="sm" variant="secondary" disabled={busy === "mode"} onClick={() => patchSettings({ publishingMode: "confirm" }, "mode")}>Вернуть подтверждение</Button>
          )}
          {!unlocked && <span className="type-caption text-text-3">Автомат откроется после {autoUnlockStreak} одобрений подряд без правок.</span>}
        </div>
        <form className="mt-5 flex flex-wrap items-end gap-3" onSubmit={(event) => { event.preventDefault(); void patchSettings({ brandName: brand }, "brand"); }}>
          <Field label="Название бренда" htmlFor="brand-name" hint="Используется в разметке Organization и в зонде видимости.">
            <Input id="brand-name" value={brand} onChange={(event) => setBrand(event.target.value)} placeholder="Например: Клиника «Улыбка»" />
          </Field>
          <Button type="submit" size="sm" variant="secondary" disabled={busy === "brand"}>Сохранить</Button>
        </form>
      </Card>

      <Card className="p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="type-h3 text-text">Раздел, который ведёт Аврора</h3>
            <p className="type-secondary mt-1 text-text-2">
              Материалы публикуются на служебном поддомене со своей картой сайта и разметкой; подходит для любого сайта без доступа к CMS.
            </p>
          </div>
          {hosted ? <Badge tone="success"><ShieldCheck className="h-3 w-3" aria-hidden />включён</Badge> : <Badge tone="neutral">выключен</Badge>}
        </div>
        {hosted && hostedOrigin && (
          <a href={hostedOrigin} target="_blank" rel="noopener noreferrer" className="type-secondary mt-3 inline-flex items-center gap-1 text-brand">
            <ExternalLink className="h-4 w-4" aria-hidden />{hostedOrigin}
          </a>
        )}
        <div className="mt-4 flex gap-2">
          {hosted ? (
            <Button type="button" size="sm" variant="ghost" disabled={busy === "delete:site_hosted"} onClick={() => remove("site_hosted")}>Выключить раздел</Button>
          ) : (
            <Button type="button" size="sm" disabled={busy === "hosted"} onClick={() => put({ kind: "site_hosted" }, "hosted")}>
              <Globe2 className="h-4 w-4" aria-hidden />Включить раздел
            </Button>
          )}
        </div>
      </Card>

      <Card className="p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="type-h3 text-text">WordPress</h3>
            <p className="type-secondary mt-1 text-text-2">
              Публикация прямо в записи сайта через REST API. Нужен пароль приложения (Пользователи → Профиль → Пароли приложений), не обычный пароль.
            </p>
          </div>
          {wordpress ? (
            <Badge tone={wordpress.readyToPublish ? "success" : "danger"}>{wordpress.readyToPublish ? "подключён" : wordpress.status === "needs_reconnect" ? "нужно переподключить" : wordpress.credentialState}</Badge>
          ) : <Badge tone="neutral">не подключён</Badge>}
        </div>
        {wordpress && (
          <dl className="type-caption mt-3 grid gap-1 text-text-2 sm:grid-cols-2">
            <div><dt className="text-text-3">Адрес</dt><dd className="break-all">{wordpress.baseUrl}</dd></div>
            <div><dt className="text-text-3">Пользователь</dt><dd>{wordpress.account?.name || "—"}</dd></div>
            <div><dt className="text-text-3">Проверено</dt><dd>{formatDate(wordpress.lastVerifiedAt, true)}</dd></div>
            {wordpress.lastErrorCode && <div><dt className="text-text-3">Последняя ошибка</dt><dd>{wordpress.lastErrorCode}</dd></div>}
          </dl>
        )}
        <form
          className="mt-4 grid gap-3 md:grid-cols-3"
          onSubmit={async (event) => {
            event.preventDefault();
            const ok = await put({ kind: "wordpress", baseUrl: wp.baseUrl, credentials: { username: wp.username, appPassword: wp.appPassword } }, "wordpress");
            if (ok) setWp({ baseUrl: "", username: "", appPassword: "" });
          }}
        >
          <Field label="Адрес сайта WordPress" htmlFor="wp-url"><Input id="wp-url" type="url" value={wp.baseUrl} onChange={(event) => setWp({ ...wp, baseUrl: event.target.value })} placeholder="https://example.ru" required /></Field>
          <Field label="Логин" htmlFor="wp-user"><Input id="wp-user" value={wp.username} onChange={(event) => setWp({ ...wp, username: event.target.value })} autoComplete="off" required /></Field>
          <Field label="Пароль приложения" htmlFor="wp-pass"><Input id="wp-pass" type="password" value={wp.appPassword} onChange={(event) => setWp({ ...wp, appPassword: event.target.value })} autoComplete="new-password" required /></Field>
          <div className="flex gap-2 md:col-span-3">
            <Button type="submit" size="sm" disabled={busy === "wordpress"}>{wordpress ? "Переподключить" : "Подключить и проверить"}</Button>
            {wordpress && <Button type="button" size="sm" variant="ghost" disabled={busy === "delete:wordpress"} onClick={() => remove("wordpress")}>Отключить</Button>}
          </div>
        </form>
        <p className="type-caption mt-3 text-text-3">Учётные данные хранятся зашифрованными и не показываются повторно. Перед сохранением Аврора проверяет доступ живым запросом.</p>
      </Card>
    </div>
  );
}
