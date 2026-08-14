"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Camera, Hash, ImagePlus, MessageCircle, Send, Sparkles, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { H2, SecondaryText } from "@/components/ui/typography";
import {
  LEGAL_OPPORTUNITY_POST_VARIANTS,
  type LegalOpportunityPostVariant,
} from "@/lib/legal-opportunity-post";
import type { RealChannel } from "@/lib/types";
import { cn } from "@/lib/utils";

export type OpportunityPostDialogTarget = {
  id: number;
  title: string;
};

function networkCopy(network: RealChannel["network"]) {
  if (network === "instagram") return { label: "Instagram", icon: Camera };
  if (network === "vk") return { label: "VK", icon: MessageCircle };
  return { label: "Telegram", icon: Send };
}

export function OpportunityPostDialog({
  target,
  channels,
  defaultChannelId,
  busy,
  onClose,
  onConfirm,
}: {
  target: OpportunityPostDialogTarget | null;
  channels: RealChannel[];
  defaultChannelId: number | null;
  busy: boolean;
  onClose: () => void;
  onConfirm: (channelId: number, variant: LegalOpportunityPostVariant) => void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const [channelId, setChannelId] = useState<number | null>(defaultChannelId ?? channels[0]?.id ?? null);
  const [variant, setVariant] = useState<LegalOpportunityPostVariant>("standard");
  const resolvedChannelId = channels.some((channel) => channel.id === channelId)
    ? channelId
    : channels.some((channel) => channel.id === defaultChannelId)
      ? defaultChannelId
      : channels[0]?.id ?? null;

  useEffect(() => {
    if (!target) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const frame = requestAnimationFrame(() => dialogRef.current?.focus());
    return () => {
      cancelAnimationFrame(frame);
      if (previousFocusRef.current?.isConnected) previousFocusRef.current.focus();
    };
  }, [target]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!target || !dialog) return;
    const inerted: Array<{ element: HTMLElement; previous: boolean }> = [];
    let current: HTMLElement = dialog;
    while (current.parentElement) {
      const parent = current.parentElement;
      for (const sibling of parent.children) {
        if (sibling !== current && sibling instanceof HTMLElement) {
          inerted.push({ element: sibling, previous: sibling.hasAttribute("inert") });
          sibling.setAttribute("inert", "");
        }
      }
      if (parent === document.body) break;
      current = parent;
    }
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      for (const item of inerted) if (!item.previous) item.element.removeAttribute("inert");
      document.body.style.overflow = previousOverflow;
    };
  }, [target]);

  if (!target) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-end justify-center bg-black/45 p-0 sm:items-center sm:p-4"
      onMouseDown={(event) => {
        if (!busy && event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        aria-busy={busy || undefined}
        tabIndex={-1}
        className="max-h-[calc(100dvh-1rem)] w-full overflow-y-auto rounded-t-md border-2 border-line bg-surface p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-card sm:max-w-2xl sm:rounded-md sm:p-6"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            if (!busy) onClose();
            return;
          }
          if (event.key !== "Tab") return;
          const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(
            "button:not([disabled]), input:not([disabled])",
          ) ?? [])];
          if (!focusable.length) return;
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (event.shiftKey && (
            document.activeElement === first || document.activeElement === dialogRef.current
          )) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        <div className="flex items-start gap-4">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-sm bg-info-soft text-brand" aria-hidden>
            <Sparkles className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <H2 id={titleId}>Создать пост из инфоповода</H2>
            <SecondaryText id={descriptionId} className="mt-1 text-pretty">
              ИИ напишет новый редактируемый текст по фактам источника — без копирования формулировок.
            </SecondaryText>
          </div>
          <Button variant="ghost" size="icon" aria-label="Закрыть" disabled={busy} onClick={onClose}>
            <X className="h-5 w-5" aria-hidden />
          </Button>
        </div>

        <div className="mt-5 rounded-sm bg-surface-2 p-4">
          <p className="type-caption font-bold tracking-[0.08em] text-text-3 uppercase">Исходный инфоповод</p>
          <p className="type-body mt-1 line-clamp-2 font-semibold text-text">{target.title}</p>
        </div>

        <fieldset className="mt-6">
          <legend><span className="type-h3 block text-text">Социальная сеть</span></legend>
          <SecondaryText className="mt-1">Выберите подключённый канал, для которого готовим версию.</SecondaryText>
          <div className="mt-3 grid gap-2 sm:grid-cols-3">
            {channels.map((channel) => {
              const copy = networkCopy(channel.network);
              const Icon = copy.icon;
              const selected = resolvedChannelId === channel.id;
              return (
                <label
                  key={channel.id}
                  className={cn(
                    "flex min-h-16 cursor-pointer items-center gap-3 rounded-sm border-2 p-3 transition-colors",
                    "hover:border-brand/45 focus-within:ring-4 focus-within:ring-brand/15",
                    selected ? "border-brand bg-info-soft" : "border-line bg-surface",
                  )}
                >
                  <input
                    type="radio"
                    name="opportunity-channel"
                    value={channel.id}
                    checked={selected}
                    disabled={busy}
                    onChange={() => setChannelId(channel.id)}
                    className="sr-only"
                  />
                  <Icon className="h-5 w-5 shrink-0 text-brand" aria-hidden />
                  <span className="min-w-0">
                    <span className="type-button block text-text">{copy.label}</span>
                    <span className="type-caption block truncate text-text-3">{channel.title || channel.handle || "Канал"}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>

        <fieldset className="mt-6">
          <legend><span className="type-h3 block text-text">Вариант подачи</span></legend>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {LEGAL_OPPORTUNITY_POST_VARIANTS.map((option) => {
              const selected = variant === option.id;
              return (
                <label
                  key={option.id}
                  className={cn(
                    "cursor-pointer rounded-sm border-2 p-3 transition-colors",
                    "hover:border-brand/45 focus-within:ring-4 focus-within:ring-brand/15",
                    selected ? "border-brand bg-info-soft" : "border-line bg-surface",
                  )}
                >
                  <input
                    type="radio"
                    name="opportunity-variant"
                    value={option.id}
                    checked={selected}
                    disabled={busy}
                    onChange={() => setVariant(option.id)}
                    className="sr-only"
                  />
                  <span className="type-button block text-text">{option.label}</span>
                  <span className="type-caption mt-1 block text-pretty text-text-3">{option.description}</span>
                </label>
              );
            })}
          </div>
        </fieldset>

        <div className="mt-5 grid gap-2 rounded-sm bg-info-soft p-4 text-info-text sm:grid-cols-2">
          <p className="type-caption flex items-center gap-2"><Hash className="h-4 w-4 shrink-0" aria-hidden />Заголовок, текст, CTA и хэштеги</p>
          <p className="type-caption flex items-center gap-2"><ImagePlus className="h-4 w-4 shrink-0" aria-hidden />Источник сохранится, изображение можно создать</p>
        </div>

        <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="secondary" disabled={busy} onClick={onClose}>Отмена</Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!resolvedChannelId}
            onClick={() => resolvedChannelId && onConfirm(resolvedChannelId, variant)}
          >
            {!busy && <Sparkles className="h-4 w-4" aria-hidden />}
            Создать пост
          </Button>
        </div>
      </div>
    </div>
  );
}
