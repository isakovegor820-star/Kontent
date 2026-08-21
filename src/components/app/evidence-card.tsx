"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, ExternalLink, FileQuestion, ShieldCheck, X } from "lucide-react";

import { Badge, Card } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import type { EvidenceProjection, EvidenceSubjectKind } from "@/lib/evidence-projection";
import { cn } from "@/lib/utils";

const STATUS = {
  passed: { tone: "success" as const, icon: CheckCircle2 },
  needs_review: { tone: "fire" as const, icon: AlertTriangle },
  blocked: { tone: "danger" as const, icon: AlertTriangle },
  not_checked: { tone: "neutral" as const, icon: FileQuestion },
  stale: { tone: "fire" as const, icon: AlertTriangle },
};

export function EvidenceCard({ kind, id, label = "Почему?", compact = false }: {
  kind: EvidenceSubjectKind; id: number; label?: string; compact?: boolean;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [evidence, setEvidence] = useState<EvidenceProjection | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "ready" | "error">("idle");

  const open = () => {
    dialogRef.current?.showModal();
    if (state === "ready" || state === "loading") return;
    setState("loading");
    void fetch(`/api/evidence/${kind}/${id}`, { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json().catch(() => null) as { evidence?: EvidenceProjection } | null;
        if (!response.ok || !body?.evidence) throw new Error("evidence_unavailable");
        setEvidence(body.evidence); setState("ready");
      })
      .catch(() => setState("error"));
  };

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const restore = () => { document.documentElement.style.overflow = ""; };
    dialog.addEventListener("close", restore);
    dialog.addEventListener("cancel", restore);
    return () => { dialog.removeEventListener("close", restore); dialog.removeEventListener("cancel", restore); restore(); };
  }, []);

  const status = evidence ? STATUS[evidence.status] : STATUS.not_checked;
  const StatusIcon = status.icon;
  return <>
    <Button variant={compact ? "ghost" : "secondary"} size="sm" onClick={() => { open(); document.documentElement.style.overflow = "hidden"; }}>
      <ShieldCheck className="h-4 w-4" aria-hidden />{label}
    </Button>
    <dialog ref={dialogRef} aria-labelledby={`evidence-title-${kind}-${id}`} aria-describedby={`evidence-description-${kind}-${id}`}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        dialogRef.current?.close();
      }}
      className="m-auto max-h-[min(88dvh,52rem)] w-[min(46rem,calc(100%-2rem))] overflow-hidden rounded-lg border border-line bg-surface p-0 text-text shadow-lg backdrop:bg-black/65">
      <div className="flex max-h-[min(88dvh,52rem)] flex-col overscroll-contain">
        <header className="flex items-start justify-between gap-4 border-b border-line px-5 py-5 sm:px-6">
          <div className="min-w-0"><p className="type-caption font-semibold text-brand">Evidence Card</p>
            <h2 id={`evidence-title-${kind}-${id}`} className="mt-1 text-balance">Почему Аврора так решила</h2>
            <p id={`evidence-description-${kind}-${id}`} className="mt-2 max-w-[65ch] text-pretty text-[14px] leading-relaxed text-text-2">Источники, проверки и ограничения для точной версии решения.</p>
          </div>
          <Button size="icon" variant="ghost" aria-label="Закрыть доказательства" onClick={() => dialogRef.current?.close()}><X className="h-5 w-5" aria-hidden /></Button>
        </header>
        <div className="min-h-0 overflow-y-auto px-5 py-5 sm:px-6" aria-live="polite">
          {state === "loading" && <div role="status" className="space-y-3"><div className="skeleton h-7 w-44 rounded-xs" /><div className="skeleton h-24 rounded-sm" /><span className="sr-only">Загружаем доказательства</span></div>}
          {state === "error" && <Card className="p-5"><h3>Доказательства временно недоступны</h3><p className="mt-2 text-[14px] leading-relaxed text-text-2">Решение не считается проверенным. Закройте панель и повторите позже.</p><Button className="mt-4" onClick={() => { setState("idle"); setEvidence(null); dialogRef.current?.close(); }}>Закрыть</Button></Card>}
          {evidence && <div className="space-y-6">
            <section aria-labelledby={`evidence-status-${kind}-${id}`}><div className="flex flex-wrap items-center gap-2"><Badge tone={status.tone}><StatusIcon className="h-3.5 w-3.5" aria-hidden />{evidence.statusLabel}</Badge><span className="type-caption tabular-nums text-text-3">Версия {evidence.subject.version}</span></div>
              <h3 id={`evidence-status-${kind}-${id}`} className="sr-only">Состояние проверки</h3><p className="mt-3 max-w-[65ch] text-pretty text-[15px] leading-relaxed text-text-2">{evidence.summary}</p></section>
            <section className="grid gap-3 sm:grid-cols-2" aria-label="Происхождение и методика">
              <Card className="p-4"><h3>Откуда взялась тема</h3>{evidence.source ? <><p className="mt-2 text-[14px] text-text-2">{evidence.source.label}</p><p className="mt-1 text-[13px] text-text-3">{evidence.source.freshness}</p>{evidence.source.href && <a className="mt-3 inline-flex min-h-11 items-center gap-2 font-semibold text-brand underline decoration-brand/40 underline-offset-4" href={evidence.source.href} target="_blank" rel="noreferrer">Открыть источник <ExternalLink className="h-4 w-4" aria-hidden /></a>}</> : <p className="mt-2 text-[14px] text-text-3">Источник для этой версии не сохранён.</p>}</Card>
              <Card className="p-4"><h3>Почему это необычно</h3><p className="mt-2 text-[14px] leading-relaxed text-text-2">{evidence.anomaly.explanation}</p><p className="mt-2 type-caption text-text-3">{evidence.anomaly.formulaVersion ? `Методика ${evidence.anomaly.formulaVersion}` : "Расчёт не выполнялся"}</p></Card>
            </section>
            <section aria-labelledby={`claims-title-${kind}-${id}`}><h3 id={`claims-title-${kind}-${id}`}>Утверждения текста</h3>
              {evidence.claims.length ? <ul className="mt-3 space-y-3">{evidence.claims.map((claim) => <li key={claim.id}><Card className="p-4"><div className="flex flex-wrap items-center gap-2"><Badge tone={claim.status === "supported" ? "success" : claim.status === "unsupported" ? "danger" : claim.status === "needs_review" ? "fire" : "neutral"}>{claim.status === "supported" ? "Подтверждено" : claim.status === "unsupported" ? "Не подтверждено" : claim.status === "needs_review" ? "Нужно проверить" : "Не проверяется"}</Badge>{claim.impact !== "none" && <span className="type-caption text-text-3">{claim.impact === "blocks_publish" ? "Блокирует публикацию" : "Нужен человек"}</span>}</div><p className="mt-3 break-words text-[14px] leading-relaxed text-text">{claim.text}</p><p className="mt-2 type-caption text-text-3">{claim.validatorVersion ? `${claim.validatorVersion} · ${claim.checkedAt ? new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium", timeStyle: "short" }).format(new Date(claim.checkedAt)) : "время неизвестно"}` : "Проверка не запускалась"}</p></Card></li>)}</ul> : <p className="mt-2 text-[14px] text-text-3">У черновика ещё нет проверяемых утверждений.</p>}
            </section>
            <section className="rounded-sm bg-surface-inset p-4"><div className="flex items-center gap-2"><FileQuestion className="h-4 w-4 text-fire-text" aria-hidden /><h3>Оригинальность: не проверено</h3></div><p className="mt-2 text-[14px] leading-relaxed text-text-2">{evidence.originality.explanation}</p></section>
            <section><h3>Что требует человека</h3><p className={cn("mt-2 max-w-[65ch] text-[14px] leading-relaxed", evidence.status === "blocked" ? "text-danger-text" : "text-text-2")}>{evidence.humanAction}</p></section>
          </div>}
        </div>
      </div>
    </dialog>
  </>;
}
