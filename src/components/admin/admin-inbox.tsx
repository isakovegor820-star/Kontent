"use client";

import { checkAdminAccess } from "./admin-ui";

import { AlertTriangle, ArrowUpRight, BarChart3, CheckCircle2, Radio, Send, Server, XCircle, type LucideIcon } from "lucide-react";
import { useEffect, useState } from "react";



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
  if ([data.system.database, data.system.redis, data.system.publicationWorker].some(state => state !== "up" && state !== "down") || ["unobserved", "not_configured"].includes(data.system.ai)) {
    items.push({ key: "system:unconfirmed", severity: "warning", icon: Server, title: "Не все сервисы подтвердили работу", detail: "Есть сервисы без результатов проверки или без настройки. Проверьте доступность перед повтором задач.", href: "/admin#system", hrefLabel: "Проверить сервисы" });
  }
  if (data.system.redis === "down") {
    items.push({ key: "system:redis", severity: "critical", icon: Server, title: "Redis недоступен", detail: "Очереди публикаций и воркеры не могут работать.", href: "/admin?system=redis#system", hrefLabel: "Открыть систему" });
  }
  if (data.system.publicationWorker === "down") {
    items.push({ key: "system:worker", severity: "critical", icon: Server, title: "Обработчик публикаций не отвечает", detail: "Время последнего сигнала работы не подтверждено. Проверьте обработчик и очередь.", href: "/admin?system=publication_worker#system", hrefLabel: "Открыть систему" });
  }
  if (data.system.ai === "attention") {
    items.push({ key: "system:ai", severity: "warning", icon: Server, title: "Aurora AI: последние вызовы с ошибками", detail: "Есть ошибки обращений к AI. Откройте диагностику провайдера.", href: "/admin?system=aurora_ai#system", hrefLabel: "Открыть систему" });
  }
  for (const provider of data.providers) {
    if (provider.attention === 0) continue;
    items.push({
      key: `provider:${provider.network}`,
      severity: "warning",
      icon: Radio,
      title: `${fmtNum(provider.attention)} ${plural(provider.attention, "канал", "канала", "каналов")} ${NETWORK_LABEL[provider.network] || provider.network} · требуется переподключение`,
      detail: provider.lastAuthErrorAt ? `Последняя ошибка авторизации ${fmtAgo(provider.lastAuthErrorAt)}.` : "Владельцы должны переподключить каналы в настройках.",
      href: `/admin?cnq=${encodeURIComponent(provider.network)}&cnstatus=attention#connections`,
      hrefLabel: "Проверить подключения",
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
    if (item.status === "auth" && data.providers.some(provider => provider.network === item.network && provider.attention > 0)) continue;
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

export function AdminInbox({ data }: { data: AdminDashboardData; onChanged: () => void }) {
  const [problems, setProblems] = useState<AuroraAnalyticsProblem[]>([]);
  const [analyticsState, setAnalyticsState] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    const controller = new AbortController();
    // Analytics problems are an enrichment: their failure never hides the domain rows.
    void fetch("/api/admin/aurora-analytics?range=24h", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        checkAdminAccess(response); if (!response.ok) throw new Error("unavailable"); return response.json() as Promise<{ problems?: AuroraAnalyticsProblem[] }>; })
      .then((payload) => { if (!controller.signal.aborted) { setProblems(Array.isArray(payload.problems) ? payload.problems : []); setAnalyticsState("ready"); } })
      .catch(() => { if (!controller.signal.aborted) { setProblems([]); setAnalyticsState("error"); } });
    return () => controller.abort();
  }, [data.checkedAt]);

  const items = buildInboxItems(data, problems);


  return (
    <section className="card-plain rounded-md p-5 sm:p-6" aria-labelledby="inbox-title">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="inbox-title" className="text-text">Требует внимания</h2>
          <p className="type-caption mt-1 text-text-3">Откройте проблему, проверьте причину и выберите действие.</p>
        </div>
        {data.attention.length > 0 ? <a href={adminPublicationsHref("/admin", { pstatus: "attention" })} className="type-caption text-brand hover:underline">Открыть все проблемные публикации</a> : null}
      </div>
      {analyticsState !== "ready" ? <p role="status" className="type-caption mt-3 text-text-3">{analyticsState === "loading" ? "Проверяем ошибки разделов…" : "Ошибки разделов не удалось загрузить. Список может быть неполным."} {analyticsState === "error" ? <a className="text-info-text underline" href="#aurora-analytics">Открыть аналитику</a> : null}</p> : null}
      {items.length === 0 ? (
        <div className="mt-5 rounded-sm bg-surface-inset p-6 text-center">
          <CheckCircle2 className="mx-auto h-8 w-8 text-text-3" aria-hidden />
          <p className="type-body-strong mt-3 text-text">В снимке нет зарегистрированных проблем</p>
          <p className="type-caption mt-1 text-text-2">Подробное состояние сервисов доступно в разделе «Система».</p>
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
                  <a href={item.href} className="type-button inline-flex min-h-9 items-center gap-1 rounded-sm border border-line px-3 text-brand hover:bg-surface-inset">{item.hrefLabel}<ArrowUpRight className="h-3.5 w-3.5" aria-hidden /></a>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
