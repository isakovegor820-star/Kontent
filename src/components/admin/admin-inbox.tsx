"use client";

import { AlertTriangle, ArrowUpRight, BarChart3, CheckCircle2, Radio, RefreshCw, Send, Server, XCircle, type LucideIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import type { AuroraAnalyticsProblem } from "@/lib/admin-aurora-analytics";
import type { AdminDashboardData } from "@/lib/admin-dashboard";
import { adminSectionLabel } from "@/lib/admin-labels";
import { adminAnalyticsHref, adminPublicationsHref, adminUsersHref } from "@/lib/admin-url-state";
import { cn, fmtAgo, fmtNum, NETWORK_LABEL, plural } from "@/lib/utils";

type Severity = "critical" | "warning";

interface InboxItem {
  key: string;
  severity: Severity;
  icon: LucideIcon;
  title: string;
  detail: string;
  href: string;
  hrefLabel: string;
  publication?: { id: number; canRetry: boolean; canCancel: boolean };
}

const ATTENTION_TITLE: Record<AdminDashboardData["attention"][number]["status"], string> = {
  failed: "Ошибка отправки",
  quarantined: "Карантин",
  overdue: "Задержка очереди",
  auth: "Канал без авторизации",
};

/**
 * Everything an admin should look at right now, from four sources, in one ordered list.
 * Publication rows expose the same retry/cancel actions as the publications center.
 */
export function buildInboxItems(data: AdminDashboardData, problems: readonly AuroraAnalyticsProblem[]): InboxItem[] {
  const items: InboxItem[] = [];
  if (data.system.redis === "down") {
    items.push({ key: "system:redis", severity: "critical", icon: Server, title: "Redis недоступен", detail: "Очереди публикаций и воркеры не могут работать.", href: "/admin?system=redis#system", hrefLabel: "Открыть систему" });
  }
  if (data.system.publicationWorker === "down") {
    items.push({ key: "system:worker", severity: "critical", icon: Server, title: "Воркер публикаций не подтверждает heartbeat", detail: "Запланированные посты не выйдут, пока воркер не поднимется.", href: "/admin?system=publication_worker#system", hrefLabel: "Открыть систему" });
  }
  if (data.system.ai === "attention") {
    items.push({ key: "system:ai", severity: "warning", icon: Server, title: "Aurora AI: последние вызовы с ошибками", detail: "Провайдер отвечает ошибками или circuit открыт.", href: "/admin?system=aurora_ai#system", hrefLabel: "Открыть систему" });
  }
  for (const provider of data.providers) {
    if (provider.attention === 0) continue;
    items.push({
      key: `provider:${provider.network}`,
      severity: "warning",
      icon: Radio,
      title: `${fmtNum(provider.attention)} ${plural(provider.attention, "канал", "канала", "каналов")} ${NETWORK_LABEL[provider.network] || provider.network} требуют переподключения`,
      detail: provider.lastAuthErrorAt ? `Последняя ошибка авторизации ${fmtAgo(provider.lastAuthErrorAt)}.` : "Владельцы должны переподключить каналы в настройках.",
      href: adminUsersHref("/admin", { status: "attention", network: provider.network }),
      hrefLabel: "Показать аккаунты",
    });
  }
  for (const problem of problems.slice(0, 5)) {
    items.push({
      key: `analytics:${problem.id}`,
      severity: problem.severity >= 3 ? "critical" : "warning",
      icon: BarChart3,
      title: problem.title,
      detail: `${problem.evidence} Затронуто ${fmtNum(problem.affectedUsers)} ${plural(problem.affectedUsers, "пользователь", "пользователя", "пользователей")}.`,
      href: adminAnalyticsHref("/admin", { analyticsSection: problem.sectionId, analyticsTab: "errors", range: "24h" }),
      hrefLabel: `Аналитика · ${adminSectionLabel(problem.sectionId)}`,
    });
  }
  for (const item of data.attention.slice(0, 12)) {
    const retryable = item.status === "failed" || item.status === "quarantined";
    items.push({
      key: `post:${item.id}`,
      severity: item.status === "overdue" ? "warning" : "critical",
      icon: Send,
      title: `${ATTENTION_TITLE[item.status]}: «${item.text.slice(0, 80)}${item.text.length > 80 ? "…" : ""}»`,
      detail: `${item.project} · ${NETWORK_LABEL[item.network] || item.network} · ${item.author} · ${item.errorCode} · ${fmtAgo(item.scheduledAt || item.createdAt)}`,
      href: item.status === "auth" ? adminUsersHref("/admin", { user: item.authorId }) : adminPublicationsHref("/admin", { pq: item.id, pstatus: "all" }),
      hrefLabel: item.status === "auth" ? "К владельцу канала" : "Открыть публикацию",
      publication: { id: item.id, canRetry: retryable, canCancel: item.status !== "auth" },
    });
  }
  const weight = (severity: Severity) => (severity === "critical" ? 0 : 1);
  return items.sort((left, right) => weight(left.severity) - weight(right.severity));
}

export function AdminInbox({ data, onChanged }: { data: AdminDashboardData; onChanged: () => void }) {
  const [problems, setProblems] = useState<AuroraAnalyticsProblem[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [pendingCancel, setPendingCancel] = useState<number | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    // Analytics problems are an enrichment: their failure never hides the domain rows.
    void fetch("/api/admin/aurora-analytics?range=24h", { cache: "no-store", signal: controller.signal })
      .then(async (response) => (response.ok ? response.json() as Promise<{ problems?: AuroraAnalyticsProblem[] }> : { problems: [] }))
      .then((payload) => setProblems(Array.isArray(payload.problems) ? payload.problems : []))
      .catch(() => undefined);
    return () => controller.abort();
  }, [data.checkedAt]);

  async function act(postId: number, action: "retry" | "cancel") {
    const key = `${action}-${postId}`;
    setBusy(key);
    setMessage(null);
    try {
      const response = await fetch("/api/admin/publications/actions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ postId, action, ...(action === "cancel" ? { reason: "Отменено администратором из инбокса" } : {}) }),
      });
      const result = await response.json().catch(() => null) as { status?: string } | null;
      if (!response.ok) throw new Error(result?.status === "in_progress" ? "Публикация сейчас отправляется — дождитесь результата." : "Действие не выполнено. Откройте центр публикаций.");
      setMessage({ tone: "success", text: action === "retry" ? `Публикация ${postId} снова в очереди.` : `Публикация ${postId} отменена.` });
      onChanged();
    } catch (error) {
      setMessage({ tone: "danger", text: error instanceof Error ? error.message : "Действие не выполнено." });
    } finally {
      setBusy(null);
    }
  }

  const items = buildInboxItems(data, problems);
  const total = data.attention.length + items.filter((item) => !item.publication).length;

  return (
    <section className="card-plain rounded-md p-5 sm:p-6" aria-labelledby="inbox-title">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="inbox-title" className="text-text">Что горит сейчас</h2>
          <p className="type-caption mt-1 text-text-3">Система, каналы, публикации и аналитика в одном списке. Действия применяются сразу.</p>
        </div>
        {data.attention.length > 12 ? <a href={adminPublicationsHref("/admin", { pstatus: "attention" })} className="type-caption text-brand hover:underline">Все {fmtNum(total)} задач в центре публикаций</a> : null}
      </div>
      {message ? <p role="status" className={cn("mt-4 rounded-sm p-3", message.tone === "success" ? "bg-success-soft text-success-text" : "bg-danger-soft text-danger-text")}>{message.text}</p> : null}
      {items.length === 0 ? (
        <div className="mt-5 rounded-sm bg-success-soft p-6 text-center">
          <CheckCircle2 className="mx-auto h-8 w-8 text-success" aria-hidden />
          <p className="type-body-strong mt-3 text-text">Инбокс пуст</p>
          <p className="type-caption mt-1 text-text-2">Очереди, каналы и публикации не требуют вмешательства.</p>
        </div>
      ) : (
        <ol className="mt-5 divide-y divide-line">
          {items.map((item) => {
            const Icon = item.icon;
            return (
              <li key={item.key} className="flex flex-col gap-3 py-3 sm:flex-row sm:items-start">
                <span className={cn("mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-sm", item.severity === "critical" ? "bg-danger-soft text-danger-text" : "bg-fire-soft text-fire-text")}>
                  <Icon className="h-4 w-4" aria-hidden />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="type-secondary font-semibold text-text">
                    {item.severity === "critical" ? <XCircle className="mr-1 inline h-3.5 w-3.5 text-danger-text" aria-hidden /> : <AlertTriangle className="mr-1 inline h-3.5 w-3.5 text-fire-text" aria-hidden />}
                    {item.title}
                  </p>
                  <p className="type-caption mt-0.5 text-text-3">{item.detail}</p>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2 sm:justify-end">
                  {item.publication?.canRetry ? (
                    <Button variant="primary" size="sm" loading={busy === `retry-${item.publication.id}`} onClick={() => void act(item.publication!.id, "retry")}>
                      <RefreshCw className="h-3.5 w-3.5" aria-hidden />Повторить
                    </Button>
                  ) : null}
                  {item.publication?.canCancel ? (
                    <Button variant="ghost" size="sm" loading={busy === `cancel-${item.publication.id}`} onClick={() => setPendingCancel(item.publication!.id)}>Отменить</Button>
                  ) : null}
                  <a href={item.href} className="type-button inline-flex min-h-9 items-center gap-1 rounded-sm border border-line px-3 text-brand hover:bg-surface-inset">{item.hrefLabel}<ArrowUpRight className="h-3.5 w-3.5" aria-hidden /></a>
                </div>
              </li>
            );
          })}
        </ol>
      )}
      <ConfirmDialog
        open={pendingCancel !== null}
        title="Отменить публикацию?"
        description={`Публикация ${pendingCancel ?? ""} будет отменена; очередь её больше не отправит. Текст сохранится у автора.`}
        confirmLabel="Отменить публикацию"
        busy={busy === `cancel-${pendingCancel}`}
        onCancel={() => setPendingCancel(null)}
        onConfirm={() => { if (pendingCancel !== null) void act(pendingCancel, "cancel").then(() => setPendingCancel(null)); }}
      />
    </section>
  );
}
