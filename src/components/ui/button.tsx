"use client";

import { forwardRef } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

type Variant = "brand" | "solid" | "soft" | "ghost" | "outline" | "danger";
type Size = "sm" | "md" | "lg" | "xl" | "icon";

// Правило ТЗ 7.2: градиент — «магнит», не больше одного на экран.
// Поэтому variant="brand" применяем только к главному действию.
const VARIANTS: Record<Variant, string> = {
  brand:
    "text-white bg-brand-gradient shadow-glow hover:brightness-110 active:brightness-95 border border-white/10",
  solid: "bg-text text-bg hover:opacity-90 active:opacity-80",
  soft: "bg-surface-inset text-text hover:bg-line-strong/20 active:bg-line-strong/30",
  ghost: "text-text-2 hover:bg-surface-inset hover:text-text active:bg-line-strong/20",
  outline:
    "border border-line-strong bg-surface text-text hover:bg-surface-inset active:bg-surface-2",
  danger: "bg-danger-soft text-danger-text hover:brightness-95 active:brightness-90",
};

// Все цели ≥44px по высоте на md и выше (a11y, touch target)
const SIZES: Record<Size, string> = {
  sm: "h-9 px-3.5 text-[13px] gap-1.5 rounded-[10px]",
  md: "h-11 px-5 text-[15px] gap-2 rounded-xs",
  lg: "h-[52px] px-7 text-base gap-2.5 rounded-sm",
  xl: "h-[60px] px-9 text-[17px] gap-3 rounded-md",
  icon: "h-11 w-11 rounded-xs",
};

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = "soft", size = "md", loading, children, disabled, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      // Хук для скоуп-скинов (app-v3 перекрашивает варианты, не трогая лендинг)
      data-variant={variant}
      className={cn(
        "relative inline-flex cursor-pointer items-center justify-center font-semibold whitespace-nowrap",
        "transition-[transform,filter,background-color,box-shadow,opacity] duration-200 ease-[var(--ease-soft)]",
        "active:scale-[0.97] disabled:pointer-events-none disabled:opacity-45",
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...props}
    >
      {loading && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
      {children}
    </button>
  );
});
