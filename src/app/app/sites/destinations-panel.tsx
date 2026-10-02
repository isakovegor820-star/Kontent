"use client";
import { useProjectCall } from "@/lib/use-project-transport";

import { useCallback, useEffect, useState } from "react";
import { CalendarClock, ChartNoAxesColumn, ExternalLink, Eye, Globe2, Lock, Plug, ShieldCheck, Unlock, Users } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge, Card, Field, Input } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";

import { errorMessage, formatDate, requestJson as unscopedRequestJson } from "./client";

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
  onOpenVerification: () => void;
};

export function DestinationsPanel({
  siteId, verified, publishingMode, approvedStreak, autoUnlockStreak, hostedOrigin, brandName, onChanged, onOpenVerification,
}: Props) {
  const requestJson = useProjectCall(unscopedRequestJson);
  const [destinations, setDestinations] = useState<Destination[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [wpOpen, setWpOpen] = useState(false);
  const [wp, setWp] = useState({ baseUrl: "", username: "", appPassword: "" });
  const [brand, setBrand] = useState(brandName || "");

  const load = useCallback(async () => {
    try {
      const { status, body } = await requestJson<{ destinations?: Destination[]; error?: string }>(`/api/sites/${siteId}/destinations`);
      if (status !== 200 || !body.destinations) throw Object.assign(new Error("list_failed"), { code: body.error });
      setDestinations(body.destinations);
      setError(null);
    } catch (caught) {
      // Ошибка запроса не должна оставлять экран в вечном «Проверяем…».
      setError(errorMessage((caught as { code?: string }).code, "Не удалось загрузить назначения публикации."));
    }
  }, [requestJson, siteId]);

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
  }, [requestJson, siteId, load, onChanged]);

  const remove = useCallback(async (kind: string) => {
    setBusy(`delete:${kind}`);
    const { status, body } = await requestJson<{ error?: string }>(`/api/sites/${siteId}/destinations?kind=${kind}`, { method: "DELETE" });
    setBusy(null);
    if (status >= 400) setError(errorMessage(body.error, "Не удалось отключить назначение."));
    await load();
    onChanged();
  }, [requestJson, siteId, load, onChanged]);

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
  }, [requestJson, siteId, onChanged]);

  const wordpress = destinations.find((item) => item.kind === "wordpress" && item.status !== "disconnected");
  const hosted = destinations.find((item) => item.kind === "site_hosted" && item.status !== "disconnected");
  const unlocked = approvedStreak >= autoUnlockStreak;

  return (
    <div className="space-y-5">
      {error && <p role="alert" className="type-secondary rounded-sm bg-danger-soft p-4 text-danger-text">{error}</p>}
      {!verified && (
        <div className="flex flex-wrap items-center gap-3 rounded-sm border-l-[3px] border-fire bg-fire-soft/60 px-4 py-3">
          <ShieldCheck className="h-5 w-5 shrink-0 text-fire-text" aria-hidden />
          <span className="type-secondary text-text-2">
            Домен не подтверждён: назначения можно настроить заранее, отправка включится после подтверждения владения.
          </span>
          <Button type="button" size="sm" variant="secondary" className="ml-auto" onClick={onOpenVerification}>Подтвердить домен</Button>
        </div>
      )}

      <div className="grid items-start gap-5 lg:grid-cols-12">
        {/* Варианты — строки одной карточки: две отдельные карточки разной высоты оставляли пустоту */}
        <Card className="lg:col-span-7">
          <div className="border-b border-line px-5 py-4 sm:px-6">
            <h3 className="type-h3 text-text">Куда публикуем</h3>
            <p className="type-caption mt-0.5 text-text-3">Можно включить оба варианта: материалы уйдут в оба места</p>
          </div>
          <ul>
            <li className="flex flex-wrap items-start gap-4 border-t border-line px-5 py-4 first:border-t-0 sm:px-6">
              <span className="grid h-11 w-11 shrink-0 place-items-center rounded-sm bg-info-soft text-brand">
                <Plug className="h-5 w-5" aria-hidden />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="type-body-strong text-text">WordPress на вашем сайте</span>
                  <Badge tone={wordpress ? (wordpress.readyToPublish ? "success" : "danger") : "neutral"}>
                    {wordpress
                      ? wordpress.readyToPublish ? "подключён" : wordpress.status === "needs_reconnect" ? "нужно переподключить" : wordpress.credentialState
                      : "не подключено"}
                  </Badge>
                </div>
                <p className="type-caption mt-1 text-text-2">
                  Материалы приходят как обычные записи WordPress: свой URL, заголовок и description. Нужен пароль приложения, а не обычный пароль.
                </p>
                {wordpress ? (
                  <dl className="type-caption mt-2 grid gap-x-6 gap-y-1 text-text-2 sm:grid-cols-2">
                    <div className="flex gap-2"><dt className="text-text-3">Адрес</dt><dd className="break-all">{wordpress.baseUrl}</dd></div>
                    <div className="flex gap-2"><dt className="text-text-3">Пользователь</dt><dd>{wordpress.account?.name || "—"}</dd></div>
                    <div className="flex gap-2"><dt className="text-text-3">Проверено</dt><dd>{formatDate(wordpress.lastVerifiedAt, true)}</dd></div>
                    {wordpress.lastErrorCode && <div className="flex gap-2"><dt className="text-text-3">Ошибка</dt><dd>{wordpress.lastErrorCode}</dd></div>}
                  </dl>
                ) : (
                  <p className="type-caption mt-2 text-text-3">Понадобится: адрес сайта · логин · пароль приложения</p>
                )}
                <div className="mt-3 flex flex-wrap gap-2">
                  {wordpress ? (
                    <>
                      <Button type="button" size="sm" variant="secondary" disabled={busy === "wordpress"} onClick={() => setWpOpen((value) => !value)}>
                        Переподключить
                      </Button>
                      <Button type="button" size="sm" variant="ghost" disabled={busy === "delete:wordpress"} onClick={() => remove("wordpress")}>Отключить</Button>
                    </>
                  ) : (
                    <Button type="button" size="sm" variant="primary" disabled={busy === "wordpress"} onClick={() => setWpOpen((value) => !value)} aria-expanded={wpOpen}>
                      Подключить
                    </Button>
                  )}
                </div>
              </div>
            </li>

            <li className="flex flex-wrap items-start gap-4 border-t border-line px-5 py-4 sm:px-6">
              <span className="grid h-11 w-11 shrink-0 place-items-center rounded-sm bg-info-soft text-brand">
                <Globe2 className="h-5 w-5" aria-hidden />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="type-body-strong text-text">Раздел с материалами на домене Авроры</span>
                  <Badge tone={hosted ? "success" : "neutral"}>{hosted ? "включён" : "не включено"}</Badge>
                </div>
                <p className="type-caption mt-1 text-text-2">
                  Готовый раздел, если нет доступа к CMS: адреса, разметка, sitemap и canonical уже настроены. Позже раздел можно повесить на свой поддомен через CNAME.
                </p>
                {hosted && hostedOrigin ? (
                  <a href={hostedOrigin} target="_blank" rel="noopener noreferrer" className="type-caption mt-2 inline-flex items-center gap-1 text-brand">
                    <ExternalLink className="h-3.5 w-3.5" aria-hidden />{hostedOrigin}
                  </a>
                ) : (
                  <p className="type-caption mt-2 text-text-3">Раздел на служебном домене индексируется, но не наследует авторитет вашего домена — это указано в отчёте.</p>
                )}
                <div className="mt-3 flex flex-wrap gap-2">
                  {hosted ? (
                    <Button type="button" size="sm" variant="ghost" disabled={busy === "delete:site_hosted"} onClick={() => remove("site_hosted")}>Выключить раздел</Button>
                  ) : (
                    <Button type="button" size="sm" variant="secondary" disabled={busy === "hosted"} onClick={() => put({ kind: "site_hosted" }, "hosted")}>
                      <Globe2 className="h-4 w-4" aria-hidden />Включить раздел
                    </Button>
                  )}
                </div>
              </div>
            </li>
          </ul>

          {wpOpen && (
            <form
              className="grid gap-3 border-t border-line bg-surface-2 px-5 py-4 sm:px-6 md:grid-cols-3"
              onSubmit={async (event) => {
                event.preventDefault();
                const ok = await put({ kind: "wordpress", baseUrl: wp.baseUrl, credentials: { username: wp.username, appPassword: wp.appPassword } }, "wordpress");
                if (ok) { setWp({ baseUrl: "", username: "", appPassword: "" }); setWpOpen(false); }
              }}
            >
              <Field label="Адрес сайта WordPress" htmlFor="wp-url">
                <Input id="wp-url" type="url" value={wp.baseUrl} onChange={(event) => setWp({ ...wp, baseUrl: event.target.value })} placeholder="https://example.ru" required />
              </Field>
              <Field label="Логин" htmlFor="wp-user">
                <Input id="wp-user" value={wp.username} onChange={(event) => setWp({ ...wp, username: event.target.value })} autoComplete="off" required />
              </Field>
              <Field label="Пароль приложения" htmlFor="wp-pass">
                <Input id="wp-pass" type="password" value={wp.appPassword} onChange={(event) => setWp({ ...wp, appPassword: event.target.value })} autoComplete="new-password" required />
              </Field>
              <div className="flex flex-wrap items-center gap-2 md:col-span-3">
                <Button type="submit" size="sm" disabled={busy === "wordpress"}>{wordpress ? "Переподключить" : "Подключить и проверить"}</Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setWpOpen(false)}>Отмена</Button>
                <span className="type-caption ml-auto text-text-3">Учётные данные хранятся зашифрованными и не показываются повторно.</span>
              </div>
            </form>
          )}
        </Card>

        <div className="flex flex-col gap-5 lg:col-span-5">
          <Card>
            <div className="border-b border-line px-5 py-4 sm:px-6">
              <h3 className="type-h3 text-text">Режим публикации</h3>
              <p className="type-caption mt-0.5 text-text-3">Кто решает, что уходит на сайт</p>
            </div>
            <div className="space-y-3 px-5 py-5 sm:px-6">
              <div className={cn(
                "flex items-center gap-3 rounded-sm border p-4",
                publishingMode === "confirm" ? "border-brand/30 bg-info-soft/50" : "border-line",
              )}>
                <span className={cn("grid h-9 w-9 shrink-0 place-items-center rounded-sm", publishingMode === "confirm" ? "bg-info-soft text-brand" : "bg-surface-inset text-text-2")}>
                  <Users className="h-5 w-5" aria-hidden />
                </span>
                <div className="min-w-0">
                  <p className="type-body-strong text-text">С подтверждением</p>
                  <p className="type-caption text-text-2">Каждый материал одобряет человек</p>
                </div>
                {publishingMode === "confirm" ? (
                  <Badge tone="brand" className="ml-auto">включено</Badge>
                ) : (
                  <Button type="button" size="sm" variant="ghost" className="ml-auto" disabled={busy === "mode"} onClick={() => patchSettings({ publishingMode: "confirm" }, "mode")}>
                    Вернуть
                  </Button>
                )}
              </div>

              <div className={cn(
                "rounded-sm border p-4",
                publishingMode === "auto" ? "border-brand/30 bg-info-soft/50" : "border-line",
              )}>
                <div className="flex items-center gap-3">
                  <span className={cn("grid h-9 w-9 shrink-0 place-items-center rounded-sm", publishingMode === "auto" ? "bg-info-soft text-brand" : "bg-surface-inset text-text-2")}>
                    {unlocked ? <Unlock className="h-5 w-5" aria-hidden /> : <Lock className="h-5 w-5" aria-hidden />}
                  </span>
                  <div className="min-w-0">
                    <p className="type-body-strong text-text">Полный автомат</p>
                    <p className="type-caption text-text-2">Публикация без одобрения человека</p>
                  </div>
                  {publishingMode === "auto"
                    ? <Badge tone="brand" className="ml-auto">включено</Badge>
                    : <Badge tone="neutral" className="ml-auto">закрыто</Badge>}
                </div>
                <p className="type-caption mt-3 text-text-3">
                  Откроется после {autoUnlockStreak} материалов, одобренных без правок. Сейчас: {approvedStreak} из {autoUnlockStreak}.
                </p>
                <span className="mt-2 block h-1.5 overflow-hidden rounded-full bg-surface-inset">
                  <span className="block h-full rounded-full bg-brand" style={{ width: `${Math.min(100, Math.round((approvedStreak / Math.max(1, autoUnlockStreak)) * 100))}%` }} />
                </span>
                {publishingMode === "confirm" && (
                  <Button
                    type="button"
                    size="sm"
                    variant={unlocked ? "primary" : "secondary"}
                    className="mt-3"
                    disabled={!unlocked || busy === "mode"}
                    onClick={() => patchSettings({ publishingMode: "auto" }, "mode")}
                  >
                    {unlocked ? <Unlock className="h-4 w-4" aria-hidden /> : <Lock className="h-4 w-4" aria-hidden />}
                    Включить автоматический режим
                  </Button>
                )}
              </div>

              <form className="flex flex-wrap items-end gap-3" onSubmit={(event) => { event.preventDefault(); void patchSettings({ brandName: brand }, "brand"); }}>
                <Field label="Название бренда" htmlFor="brand-name" hint="Используется в разметке Organization и в зонде видимости.">
                  <Input id="brand-name" value={brand} onChange={(event) => setBrand(event.target.value)} placeholder="Например: АСПБ" />
                </Field>
                <Button type="submit" size="sm" variant="secondary" disabled={busy === "brand"}>Сохранить</Button>
              </form>
            </div>
          </Card>

          <Card>
            <div className="border-b border-line px-5 py-4 sm:px-6">
              <h3 className="type-h3 text-text">Что и когда публикуется</h3>
              <p className="type-caption mt-0.5 text-text-3">Расписание планировщика сайта</p>
            </div>
            <ul>
              <li className="flex items-center gap-3 border-t border-line px-5 py-4 first:border-t-0 sm:px-6">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-sm bg-surface-inset text-text-2"><CalendarClock className="h-4 w-4" aria-hidden /></span>
                <span className="min-w-0 flex-1">
                  <span className="type-body-strong block text-text">Планирование материалов</span>
                  <span className="type-caption text-text-2">раз в день по профилю сайта</span>
                </span>
                <Badge tone="success" className="ml-auto">включено</Badge>
              </li>
              <li className="flex items-center gap-3 border-t border-line px-5 py-4 sm:px-6">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-sm bg-surface-inset text-text-2"><Eye className="h-4 w-4" aria-hidden /></span>
                <span className="min-w-0 flex-1">
                  <span className="type-body-strong block text-text">Зонд видимости в ИИ</span>
                  <span className="type-caption text-text-2">раз в 30 дней, 12 вопросов × 3 движка</span>
                </span>
                <Badge tone={verified ? "success" : "neutral"} className="ml-auto">{verified ? "включено" : "ждёт домена"}</Badge>
              </li>
              <li className="flex items-center gap-3 border-t border-line px-5 py-4 sm:px-6">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-sm bg-surface-inset text-text-2"><ChartNoAxesColumn className="h-4 w-4" aria-hidden /></span>
                <span className="min-w-0 flex-1">
                  <span className="type-body-strong block text-text">Ежемесячный отчёт</span>
                  <span className="type-caption text-text-2">1-го числа, с динамикой к прошлому</span>
                </span>
                <Badge tone="success" className="ml-auto">включено</Badge>
              </li>
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}
