"use client";

// Базовые кирпичики интерфейса. Один набор на лендинг и платформу (ТЗ 7.3:
// «карточки как основной строительный блок», «мягкие тени вместо рамок»).

import { forwardRef } from "react";
import { Check, Minus } from "lucide-react";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------- КАРТОЧКИ */

export function Card({
  className,
  as: Tag = "div",
  ...props
}: React.HTMLAttributes<HTMLElement> & { as?: React.ElementType }) {
  return <Tag className={cn("card-plain rounded-md", className)} {...props} />;
}

export function GlassCard({
  className,
  strong,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { strong?: boolean }) {
  return <div className={cn(strong ? "glass-strong" : "glass", "rounded-lg", className)} {...props} />;
}

/* --------------------------------------------------------------- БЕЙДЖИ */

type Tone = "brand" | "success" | "danger" | "fire" | "neutral";

const TONES: Record<Tone, string> = {
  brand: "bg-info-soft text-info-text",
  success: "bg-success-soft text-success-text",
  danger: "bg-danger-soft text-danger-text",
  fire: "bg-fire-soft text-fire-text",
  neutral: "bg-surface-inset text-text-2",
};

export function Badge({
  tone = "neutral",
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { tone?: Tone }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] leading-none font-semibold",
        TONES[tone],
        className,
      )}
      {...props}
    >
      {children}
    </span>
  );
}

/* ---------------------------------------------------------------- ПОЛЯ */

export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return (
      <input
        ref={ref}
        className={cn(
          "h-12 w-full rounded-xs border border-line bg-surface px-4 text-[15px] text-text",
          "placeholder:text-text-3 transition-colors duration-200",
          "hover:border-line-strong focus:border-brand focus:outline-none",
          "focus-visible:ring-4 focus-visible:ring-brand/15",
          "disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        {...props}
      />
    );
  },
);

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, ...props }, ref) {
  return (
    <textarea
      ref={ref}
      className={cn(
        "w-full resize-none rounded-sm border border-line bg-surface p-4 text-[15px] leading-relaxed text-text",
        "placeholder:text-text-3 transition-colors duration-200",
        "hover:border-line-strong focus:border-brand focus:outline-none",
        "focus-visible:ring-4 focus-visible:ring-brand/15",
        className,
      )}
      {...props}
    />
  );
});

export function Field({
  label,
  hint,
  error,
  htmlFor,
  required,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  htmlFor?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      {/* Метка всегда видима — не плейсхолдер (a11y) */}
      <label htmlFor={htmlFor} className="block text-[13px] font-semibold text-text-2">
        {label}
        {required && <span className="ml-1 text-danger">*</span>}
      </label>
      {children}
      {/* Ошибка — рядом с полем, с ролью alert */}
      {error ? (
        <p role="alert" className="text-[13px] font-medium text-danger-text">
          {error}
        </p>
      ) : hint ? (
        <p className="text-[13px] text-text-3">{hint}</p>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------- ПЕРЕКЛЮЧАТЕЛИ */

/**
 * Переключатель вкл/выкл. Один на всю платформу — и в настройках, и в автопилоте.
 *
 * Кружок раскладываем через flex + padding, а НЕ через absolute. У <button> по
 * умолчанию text-align: center, поэтому абсолютный кружок без left отсчитывается
 * от ЦЕНТРА дорожки и уезжает за её край. Рамка есть всегда (во включённом
 * состоянии — прозрачная), иначе кружок дёргается на 1px при переключении.
 */
export function Switch({
  checked,
  onChange,
  label,
  id,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  id?: string;
}) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        "inline-flex h-7 w-12 shrink-0 cursor-pointer items-center rounded-full border p-0.5",
        "transition-colors duration-200 focus-visible:ring-4 focus-visible:ring-brand/15",
        checked ? "border-transparent bg-brand-gradient" : "border-line bg-surface-inset",
      )}
    >
      {/* дорожка 48 − 2 (рамка) − 4 (padding) = 42; кружок 20 ⇒ ход ровно 22px */}
      <span
        className={cn(
          "h-5 w-5 rounded-full bg-white shadow-sm transition-transform duration-200 ease-[var(--ease-spring)]",
          checked ? "translate-x-[22px]" : "translate-x-0",
        )}
      />
    </button>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  description,
  id,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  description?: string;
  id?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-6">
      <div className="min-w-0">
        <label htmlFor={id} className="block cursor-pointer text-[15px] font-semibold text-text">
          {label}
        </label>
        {description && <p className="mt-1 text-[13px] leading-relaxed text-text-2">{description}</p>}
      </div>
      <span className="mt-0.5">
        <Switch checked={checked} onChange={onChange} label={label} id={id} />
      </span>
    </div>
  );
}

export function Checkbox({
  checked,
  onChange,
  label,
  id,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: React.ReactNode;
  id?: string;
}) {
  return (
    <button
      id={id}
      type="button"
      role="checkbox"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="group flex cursor-pointer items-center gap-2.5 text-left"
    >
      <span
        className={cn(
          "flex h-5 w-5 shrink-0 items-center justify-center rounded-[6px] border transition-all duration-200",
          checked
            ? "border-transparent bg-brand-gradient text-white"
            : "border-line-strong bg-surface group-hover:border-brand",
        )}
      >
        {checked && <Check className="h-3.5 w-3.5" strokeWidth={3} aria-hidden />}
      </span>
      <span className="text-[14px] font-medium text-text">{label}</span>
    </button>
  );
}

/* -------------------------------------------------------------- ВКЛАДКИ */

export function Tabs<T extends string>({
  value,
  onChange,
  items,
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  items: { value: T; label: string; icon?: React.ReactNode }[];
  className?: string;
}) {
  return (
    <div
      role="tablist"
      className={cn(
        "inline-flex gap-1 rounded-sm border border-line bg-surface-inset p-1",
        className,
      )}
    >
      {items.map((it) => {
        const active = it.value === value;
        return (
          <button
            key={it.value}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(it.value)}
            className={cn(
              "inline-flex cursor-pointer items-center gap-1.5 rounded-[9px] px-3.5 py-2 text-[13px] font-semibold",
              "transition-all duration-200",
              active
                ? "bg-surface text-text shadow-soft"
                : "text-text-2 hover:text-text",
            )}
          >
            {it.icon}
            {it.label}
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------- ИКОНКИ СЕТЕЙ */
// Официальные глифы. Не эмодзи (правило дизайн-системы).

export function TelegramIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" />
    </svg>
  );
}

export function VkIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M13.162 18.994c.609 0 .858-.406.851-.915-.031-1.917.714-2.949 2.059-1.604 1.488 1.488 1.796 2.519 3.603 2.519h3.2c.808 0 1.126-.26 1.126-.668 0-.863-1.421-2.386-2.625-3.504-1.686-1.565-1.765-1.602-.313-3.486 1.801-2.339 4.157-5.336 2.073-5.336h-3.981c-.772 0-.828.435-1.103 1.083-.995 2.347-2.886 5.387-3.604 4.922-.751-.485-.407-2.406-.35-5.261.015-.754.011-1.271-1.141-1.539-.629-.145-1.241-.205-1.809-.205-2.273 0-3.841.953-2.95 1.119 1.571.293 1.42 3.692 1.054 5.16-.638 2.556-3.036-2.024-4.035-4.305-.241-.548-.315-.974-1.175-.974H.482c-.483 0-.482.239-.482.708 0 .589 1.849 5.548 5.049 9.014 3.106 3.365 6.037 3.302 8.113 3.302z" />
    </svg>
  );
}

/* ---------------------------------------------------------- РАЗДЕЛИТЕЛЬ */

export function Divider({ className }: { className?: string }) {
  return <div className={cn("h-px w-full bg-line", className)} aria-hidden />;
}

/* -------------------------------------------------------- ПУСТОЕ СОСТОЯНИЕ */

export function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon?: React.ReactNode;
  title: string;
  body?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-14 text-center">
      {icon && (
        <div className="flex h-12 w-12 items-center justify-center rounded-md bg-surface-inset text-text-3">
          {icon}
        </div>
      )}
      <div>
        <p className="text-[15px] font-semibold text-text">{title}</p>
        {body && <p className="mx-auto mt-1 max-w-sm text-[14px] leading-relaxed text-text-2">{body}</p>}
      </div>
      {action}
    </div>
  );
}

/* ---------------------------------------------------- СТАТУС «ЕСТЬ/НЕТ» */

export function YesNo({ value }: { value: boolean | "partial" }) {
  if (value === "partial") {
    return (
      <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-fire-soft text-fire-text">
        <Minus className="h-4 w-4" strokeWidth={3} aria-hidden />
        <span className="sr-only">Частично</span>
      </span>
    );
  }
  return value ? (
    <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-success-soft text-success-text">
      <Check className="h-4 w-4" strokeWidth={3} aria-hidden />
      <span className="sr-only">Есть</span>
    </span>
  ) : (
    <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-surface-inset text-text-3">
      <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden>
        <path
          d="M4 4l8 8M12 4l-8 8"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
        />
      </svg>
      <span className="sr-only">Нет</span>
    </span>
  );
}
