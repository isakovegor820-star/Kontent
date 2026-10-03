"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ShieldCheck, Undo2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Badge, Card } from "@/components/ui/primitives";
import { CONSENT_KINDS, type ConsentKind } from "@/lib/consent";

/**
 * «Мои согласия»: что человек разрешил, на каком тексте и как это отозвать.
 *
 * Право отозвать согласие прямо закреплено законом (ч. 2 ст. 9 152-ФЗ), а
 * отзыв не удаляет историю: оператор обязан доказать, что до отзыва обработка
 * была законной. Поэтому отзыв — новая запись журнала, и после него согласие
 * можно дать снова.
 */

type ConsentState = {
  kind: ConsentKind;
  granted: boolean;
  changedAt: string;
  consentTextVersion: string | null;
  policyVersion: string | null;
  source: string | null;
};

type ConsentHistoryEntry = {
  kind: ConsentKind;
  granted: boolean;
  at: string;
  source: string | null;
  consentTextVersion: string | null;
  policyVersion: string | null;
};

type ConsentsResponse = {
  ok?: boolean;
  error?: string;
  required?: boolean;
  current?: ConsentState[];
  history?: ConsentHistoryEntry[];
};

const KIND_LABELS: Record<ConsentKind, string> = {
  pd_processing: "Обработка персональных данных",
  marketing: "Сообщения и рассылки",
  pd_distribution: "Распространение данных в публичном разделе",
  cookie: "Аналитические cookie",
};

const KIND_DESCRIPTIONS: Record<ConsentKind, string> = {
  pd_processing: "Аккаунт, вход, работа проектов и ответы на обращения.",
  marketing: "Письма и сообщения о продукте. Отзыв не влияет на работу аккаунта.",
  pd_distribution: "Показ имени и материалов в публичном разделе проекта.",
  cookie: "Счётчики аналитики. Необходимые cookie работают всегда — без них сервис не открывается.",
};

const SOURCE_LABELS: Record<string, string> = {
  register: "форма регистрации",
  lead: "форма заявки",
  cabinet: "кабинет",
  sites: "подключение сайта",
};

function formatMoment(value: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return new Intl.DateTimeFormat("ru-RU", { dateStyle: "long", timeStyle: "short" }).format(date);
}

function sourceLabel(source: string | null): string {
  if (!source) return "источник не указан";
  return SOURCE_LABELS[source] ?? source;
}

export function ConsentsSettings() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [current, setCurrent] = useState<ConsentState[]>([]);
  const [history, setHistory] = useState<ConsentHistoryEntry[]>([]);
  const [revoking, setRevoking] = useState<ConsentKind | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    // Состояние загрузки не трогаем в эффекте: первый рендер уже идёт с
    // loading = true, а повторная загрузка (после отзыва) выставляет его сама.
    setError(undefined);
    try {
      const response = await fetch("/api/settings/consents", { headers: { accept: "application/json" } });
      const body = (await response.json().catch(() => null)) as ConsentsResponse | null;
      if (!response.ok || !body?.ok) {
        setError("Не удалось загрузить согласия. Обновите страницу.");
        return;
      }
      setCurrent(body.current ?? []);
      setHistory(body.history ?? []);
    } catch {
      setError("Не удалось загрузить согласия. Проверьте соединение.");
    } finally {
      setLoading(false);
    }
  }, []);

  // Загрузка авторитетного состояния согласий при открытии раздела: тот же
  // приём, что в legal-sources-section — состояние ставится из ответа сервера.
  /* eslint-disable react-hooks/set-state-in-effect -- load consents on mount */
  useEffect(() => {
    void load();
  }, [load]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const revoke = useCallback(async () => {
    if (!revoking) return;
    setBusy(true);
    try {
      const response = await fetch("/api/settings/consents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: revoking }),
      });
      const body = (await response.json().catch(() => null)) as ConsentsResponse | null;
      if (response.ok && body?.ok) {
        setCurrent(body.current ?? []);
        await load();
      } else if (response.status === 409) {
        setError("Это согласие уже отозвано.");
      } else {
        setError("Не удалось отозвать согласие. Попробуйте ещё раз.");
      }
    } catch {
      setError("Не удалось отозвать согласие. Проверьте соединение.");
    } finally {
      setBusy(false);
      setRevoking(null);
    }
  }, [load, revoking]);

  const orderedHistory = useMemo(() => history.slice(0, 12), [history]);

  return (
    <div className="space-y-4" data-setting-target="consents">
      <Card className="p-5">
        <div className="flex items-start gap-3">
          <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-info" aria-hidden />
          <div className="min-w-0">
            <h3 className="text-[15px] font-bold text-text">Мои согласия</h3>
            <p className="mt-1 max-w-[70ch] text-[13px] leading-relaxed text-text-2">
              Здесь видно, на что вы согласились, когда и на каком тексте. Согласие можно отозвать в любой
              момент: обработка прекратится, а история согласий сохранится как доказательство. Подробнее — в{" "}
              <Link className="font-semibold text-info underline underline-offset-2" href="/consent">
                тексте согласия
              </Link>{" "}
              и{" "}
              <Link className="font-semibold text-info underline underline-offset-2" href="/privacy">
                политике обработки данных
              </Link>
              .
            </p>
          </div>
        </div>

        {error ? (
          <p role="alert" className="mt-4 rounded-sm bg-danger-soft p-3 text-[13px] text-danger-text">
            {error}
          </p>
        ) : null}

        <ul className="mt-5 space-y-3">
          {loading ? (
            <li className="text-[13px] text-text-2">Загружаем согласия…</li>
          ) : (
            current.map((item) => (
              <li
                key={item.kind}
                className="flex flex-col gap-3 rounded-sm border border-line p-4 sm:flex-row sm:items-start sm:justify-between"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[14px] font-semibold text-text">{KIND_LABELS[item.kind]}</span>
                    <Badge tone={item.granted ? "success" : "neutral"}>
                      {item.granted ? "Согласие действует" : "Согласия нет"}
                    </Badge>
                  </div>
                  <p className="mt-1 max-w-[70ch] text-[13px] leading-relaxed text-text-2">
                    {KIND_DESCRIPTIONS[item.kind]}
                  </p>
                  {item.granted && item.changedAt ? (
                    <p className="mt-2 text-[12px] text-text-3">
                      Дано {formatMoment(item.changedAt)} · {sourceLabel(item.source)}
                      {item.consentTextVersion ? ` · текст ${item.consentTextVersion}` : ""}
                      {item.policyVersion ? ` · политика ${item.policyVersion}` : ""}
                    </p>
                  ) : null}
                </div>
                {item.granted && item.kind !== "cookie" ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setRevoking(item.kind)}
                    className="shrink-0"
                  >
                    <Undo2 className="h-4 w-4" aria-hidden />
                    Отозвать
                  </Button>
                ) : null}
                {item.kind === "cookie" && item.granted ? (
                  <span className="shrink-0 text-[12px] text-text-3">
                    Изменяется кнопкой «Настройки cookie» в подвале
                  </span>
                ) : null}
              </li>
            ))
          )}
        </ul>
      </Card>

      {orderedHistory.length ? (
        <Card className="p-5">
          <h3 className="text-[15px] font-bold text-text">История согласий</h3>
          <p className="mt-1 text-[13px] leading-relaxed text-text-2">
            Каждая выдача и каждый отзыв — отдельная запись. По ней видно, на каком тексте вы согласились.
          </p>
          <ul className="mt-4 space-y-2">
            {orderedHistory.map((entry, index) => (
              <li key={`${entry.kind}-${entry.at}-${index}`} className="flex flex-wrap items-baseline gap-x-2 text-[13px]">
                <span className={entry.granted ? "text-success-text" : "text-text-3"}>
                  {entry.granted ? "Согласие дано" : "Согласие отозвано"}
                </span>
                <span className="text-text">{KIND_LABELS[entry.kind]}</span>
                <span className="text-text-3">
                  {formatMoment(entry.at)} · {sourceLabel(entry.source)}
                  {entry.consentTextVersion ? ` · текст ${entry.consentTextVersion}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <ConfirmDialog
        open={revoking !== null}
        title="Отозвать согласие?"
        description={
          revoking
            ? `Обработка по пункту «${KIND_LABELS[revoking]}» прекратится. История согласий сохранится, а согласие можно будет дать снова.`
            : ""
        }
        confirmLabel="Отозвать согласие"
        busy={busy}
        onCancel={() => {
          if (!busy) setRevoking(null);
        }}
        onConfirm={() => void revoke()}
      />
    </div>
  );
}

/** Виды согласия, которые интерфейс обязан показать: используется в тестах. */
export const CONSENT_UI_KINDS = CONSENT_KINDS;
