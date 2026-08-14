"use client";

import { forwardRef } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

export type CanonicalButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonVariant =
  | CanonicalButtonVariant
  // Backward-compatible aliases. New code should use primary/secondary.
  | "brand"
  | "solid"
  | "soft"
  | "outline";
export type ButtonSize = "sm" | "md" | "lg" | "xl" | "icon";

// Цвет кодирует смысл действия: один синий primary, нейтральный secondary,
// спокойный ghost и отдельный красный danger.
const VARIANTS: Record<CanonicalButtonVariant, string> = {
  primary:
    "text-white bg-brand shadow-glow [&:not(:disabled):hover]:bg-brand-hover [&:not(:disabled):active]:bg-brand-active border border-white/10",
  secondary:
    "border border-line-strong bg-surface text-text [&:not(:disabled):hover]:bg-surface-inset [&:not(:disabled):active]:bg-surface-2",
  ghost: "text-text-2 [&:not(:disabled):hover]:bg-surface-inset [&:not(:disabled):hover]:text-text [&:not(:disabled):active]:bg-line-strong/20",
  danger:
    "border border-danger/20 bg-danger-soft text-danger-text [&:not(:disabled):hover]:bg-danger/15 [&:not(:disabled):active]:bg-danger/20",
};

export function canonicalButtonVariant(variant: ButtonVariant): CanonicalButtonVariant {
  if (variant === "brand" || variant === "solid") return "primary";
  if (variant === "soft" || variant === "outline") return "secondary";
  return variant;
}

// Все интерактивные цели ≥44px по высоте, включая compact-вариант.
const SIZES: Record<ButtonSize, string> = {
  sm: "min-h-11 px-3.5 py-2 gap-1.5 rounded-[10px]",
  md: "h-11 px-5 gap-2 rounded-xs",
  lg: "h-[52px] px-7 gap-2.5 rounded-sm",
  xl: "h-[60px] px-9 gap-3 rounded-md",
  icon: "h-11 w-11 rounded-xs",
};

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
}

// Ссылки-действия получают ту же геометрию и состояния, но остаются настоящими
// ссылками. Это не создаёт запрещённую вложенность <a><button>.
export function buttonClassName({
  className,
  variant = "secondary",
  size = "md",
  loading = false,
}: {
  className?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
} = {}) {
  const canonicalVariant = canonicalButtonVariant(variant);

  return cn(
    "type-button relative inline-flex cursor-pointer items-center justify-center whitespace-nowrap",
    "transition-[transform,background-color,border-color,box-shadow,color,opacity] duration-150 ease-[var(--ease-soft)] motion-reduce:transition-none",
    "[&:not(:disabled):active]:scale-[0.96] motion-reduce:transform-none",
    loading ? "cursor-wait" : "disabled:cursor-not-allowed disabled:opacity-45",
    VARIANTS[canonicalVariant],
    SIZES[size],
    className,
  );
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = "secondary", size = "md", loading = false, children, disabled, type = "button", ...props },
  ref,
) {
  const canonicalVariant = canonicalButtonVariant(variant);

  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      data-loading={loading || undefined}
      // Скоуп-скины получают только четыре канонических роли, включая legacy-вызовы.
      data-variant={canonicalVariant}
      className={buttonClassName({ className, variant, size, loading })}
      {...props}
    >
      {loading && <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />}
      {children}
    </button>
  );
});
