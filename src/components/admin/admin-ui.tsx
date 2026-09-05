"use client";

import { Check, Clock3, Copy, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

export const ADMIN_STALE_MS = 5 * 60_000;

export function useSnapshotAge(checkedAt?: string | null) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);
  const time = checkedAt ? Date.parse(checkedAt) : NaN;
  return !Number.isFinite(time) || now - time > ADMIN_STALE_MS;
}

/** Shared read failures invalidate the entire admin surface on session/access loss. */
export async function adminJson<T>(response: Response): Promise<T> {
  checkAdminAccess(response);
  if (!response.ok) throw new Error(`admin_http_${response.status}`);
  return response.json() as Promise<T>;
}

export function checkAdminAccess(response: Response) {
  if (response.status === 401 || response.status === 403) {
    window.dispatchEvent(new CustomEvent("aurora:admin-access", { detail: response.status }));
    throw new Error(response.status === 401 ? "unauthorized" : "access_denied");
  }
}

export function SnapshotNote({ checkedAt, period, failed = false, busy = false, onRefresh }: {
  checkedAt?: string | null; period?: string; failed?: boolean; busy?: boolean; onRefresh?: () => void;
}) {
  const stale = useSnapshotAge(checkedAt);
  return <div className={`type-caption flex flex-wrap items-center gap-x-4 gap-y-2 ${stale || failed ? "text-fire-text" : "text-text-3"}`}>
    {period ? <span>{period}</span> : null}
    <span className="inline-flex items-center gap-1.5"><Clock3 className="h-3.5 w-3.5 shrink-0" aria-hidden />
      {failed ? "Не удалось обновить · " : stale && checkedAt ? "Данные устарели · " : ""}
      {checkedAt ? <time dateTime={checkedAt}>Снимок: {new Date(checkedAt).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time> : "Данные ещё не получены"}
    </span>
    {(failed || (stale && checkedAt)) && onRefresh ? <Button variant="secondary" size="sm" loading={busy} onClick={onRefresh}><RefreshCw className="h-3.5 w-3.5" aria-hidden />Обновить данные</Button> : null}
  </div>;
}

export function CopyValue({ value, label = "значение" }: { value: string | number; label?: string }) {
  const [message, setMessage] = useState("");
  return <span className="inline-flex max-w-full items-center gap-1.5 align-middle">
    <code className="type-caption min-w-0 break-all text-text-2">{value}</code>
    <button type="button" className="inline-grid min-h-9 min-w-9 shrink-0 place-items-center rounded-xs border border-line text-text-2 hover:bg-surface-inset" aria-label={`Копировать ${label}`} onClick={async () => {
      try { await navigator.clipboard.writeText(String(value)); setMessage("Скопировано"); }
      catch { setMessage("Не удалось скопировать. Выделите значение и скопируйте вручную."); }
    }}>{message === "Скопировано" ? <Check className="h-4 w-4" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}</button>
    <span role="status" className="type-caption text-text-2">{message}</span>
  </span>;
}

export function ReadError({ title, onRetry }: { title: string; onRetry: () => void }) {
  return <div role="alert" className="mt-4 rounded-md border border-danger/30 bg-danger-soft p-5">
    <p className="type-body-strong text-danger-text">{title}</p>
    <p className="type-secondary mt-2 text-text-2">Данные не изменены. Проверьте соединение и повторите загрузку.</p>
    <Button variant="secondary" className="mt-3" onClick={onRetry}>Повторить попытку</Button>
  </div>;
}
