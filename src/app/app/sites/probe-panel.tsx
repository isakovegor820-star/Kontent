"use client";

import { useCallback, useEffect, useState } from "react";
import { Radar } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge, Card } from "@/components/ui/primitives";

import { errorMessage, formatDate, requestJson } from "./client";

type ProbeRow = {
  questionKey: string;
  question: string;
  engine: string;
  brandMentioned: boolean;
  siteCited: boolean;
  competitors: Array<{ name: string; kind: string }>;
  excerpt: string | null;
  status: string;
};

type RunSummary = {
  runKey: string;
  checkedAt: string;
  questions: number;
  answers: number;
  skipped: number;
  failed: number;
  brandMentioned: number;
  siteCited: number;
  engines: string[];
  competitorsTop: Array<{ name: string; mentions: number }>;
};

type Props = { siteId: number; verified: boolean; hasProfile: boolean };

export function ProbePanel({ siteId, verified, hasProfile }: Props) {
  const [latest, setLatest] = useState<(RunSummary & { rows: ProbeRow[] }) | null>(null);
  const [history, setHistory] = useState<RunSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      const { status, body } = await requestJson<{ latest?: (RunSummary & { rows: ProbeRow[] }) | null; history?: RunSummary[]; error?: string }>(`/api/sites/${siteId}/probe`);
      if (status !== 200) throw Object.assign(new Error("probe_failed"), { code: body.error });
      setLatest(body.latest ?? null);
      setHistory(body.history ?? []);
      setError(null);
    } catch (caught) {
      setError(errorMessage((caught as { code?: string }).code, "Не удалось загрузить данные зонда."));
    } finally {
      setLoaded(true);
    }
  }, [siteId]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- state changes only after the request settles
  useEffect(() => { void load(); }, [load]);

  const run = useCallback(async () => {
    setBusy(true);
    setError(null);
    const { status, body } = await requestJson<{ error?: string }>(`/api/sites/${siteId}/probe`, { method: "POST", body: JSON.stringify({}) });
    setBusy(false);
    if (status >= 400) setError(errorMessage(body.error, "Не удалось запустить зонд."));
    else setTimeout(() => void load(), 5000);
  }, [siteId, load]);

  const byQuestion = new Map<string, ProbeRow[]>();
  for (const row of latest?.rows || []) {
    const list = byQuestion.get(row.questionKey) || [];
    list.push(row);
    byQuestion.set(row.questionKey, list);
  }

  return (
    <div className="space-y-6">
      {error && <p role="alert" className="type-secondary rounded-sm bg-danger-soft p-4 text-danger-text">{error}</p>}
      <Card className="p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="type-h3 text-text">Видимость в ответах ИИ (GEO / AEO)</h3>
            <p className="type-secondary mt-1 text-text-2">
              Аврора задаёт подключённым движкам одни и те же вопросы вашей ниши и смотрит, называют ли вас без подсказки. Это воспроизводимая динамика, а не замер реальной выдачи.
            </p>
          </div>
          <Button type="button" size="sm" variant="secondary" onClick={run} disabled={busy || !verified || !hasProfile}>
            <Radar className="h-4 w-4" aria-hidden />Запустить зонд
          </Button>
        </div>
        {!verified && <p className="type-caption mt-3 text-fire-text">Зонд доступен после подтверждения домена.</p>}
        {loaded && !latest && verified && <p className="type-secondary mt-4 text-text-2">Зонд ещё не запускался. Он выполняется автоматически раз в 30 дней; можно запустить вручную.</p>}
        {latest && (
          <>
            <dl className="mt-5 grid gap-3 sm:grid-cols-4">
              <div className="rounded-sm bg-surface-inset p-3"><dt className="type-caption text-text-3">Вопросов</dt><dd className="type-body-strong text-text">{latest.questions}</dd></div>
              <div className="rounded-sm bg-surface-inset p-3"><dt className="type-caption text-text-3">Бренд упомянут</dt><dd className="type-body-strong text-text">{latest.brandMentioned}</dd></div>
              <div className="rounded-sm bg-surface-inset p-3"><dt className="type-caption text-text-3">Сайт процитирован</dt><dd className="type-body-strong text-text">{latest.siteCited}</dd></div>
              <div className="rounded-sm bg-surface-inset p-3"><dt className="type-caption text-text-3">Движков</dt><dd className="type-body-strong text-text">{latest.engines.length}</dd></div>
            </dl>
            {latest.skipped > 0 && latest.answers === 0 && <p className="type-caption mt-3 text-fire-text">Прогон пропущен: исчерпан дневной лимит ИИ.</p>}
            {latest.brandMentioned === 0 && latest.answers > 0 && (
              <p className="type-secondary mt-4 rounded-sm bg-fire-soft p-4 text-fire-text">
                По вашему бренду в ответах ИИ пусто. Причины видны в профиле: чаще всего это отсутствие структурированных данных об организации и внешних упоминаний.
              </p>
            )}
            {latest.competitorsTop.length > 0 && (
              <p className="type-secondary mt-3 text-text-2">
                Вместо вас движки называют: {latest.competitorsTop.slice(0, 5).map((item) => `${item.name} (${item.mentions})`).join(", ")}.
              </p>
            )}
            <p className="type-caption mt-3 text-text-3">Прогон {latest.runKey} · {formatDate(latest.checkedAt, true)}</p>
          </>
        )}
      </Card>

      {latest && byQuestion.size > 0 && (
        <Card className="p-5 sm:p-6">
          <h4 className="type-body-strong text-text">Вопросы и ответы движков</h4>
          <ul className="mt-4 space-y-4">
            {[...byQuestion.entries()].map(([key, rows]) => (
              <li key={key} className="rounded-sm border border-line bg-surface-2 p-4">
                <p className="type-label text-text">{rows[0].question}</p>
                <ul className="mt-2 space-y-2">
                  {rows.map((row) => (
                    <li key={`${row.questionKey}-${row.engine}`} className="type-caption text-text-2">
                      <span className="flex flex-wrap items-center gap-2">
                        <Badge tone="neutral">{row.engine}</Badge>
                        {row.status !== "answered" ? <Badge tone="fire">{row.status === "skipped_budget" ? "лимит" : "ошибка"}</Badge> : null}
                        {row.brandMentioned && <Badge tone="success">бренд упомянут</Badge>}
                        {row.siteCited && <Badge tone="success">сайт процитирован</Badge>}
                        {row.competitors.length > 0 && <span className="text-text-3">названы: {row.competitors.map((item) => item.name).join(", ")}</span>}
                      </span>
                      {row.excerpt && <p className="mt-1 line-clamp-3 text-text-3">{row.excerpt}</p>}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {history.length > 1 && (
        <Card className="p-5 sm:p-6">
          <h4 className="type-body-strong text-text">Динамика прогонов</h4>
          <table className="mt-3 w-full text-left">
            <thead><tr className="type-caption text-text-3"><th className="py-1">Прогон</th><th>Вопросов</th><th>Бренд</th><th>Сайт</th></tr></thead>
            <tbody>
              {history.map((run) => (
                <tr key={run.runKey} className="type-caption border-t border-line text-text-2">
                  <td className="py-1.5">{run.runKey}</td><td>{run.questions}</td><td>{run.brandMentioned}</td><td>{run.siteCited}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
