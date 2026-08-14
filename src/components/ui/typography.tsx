import { cn } from "@/lib/utils";

export type TypographyTone = "default" | "danger" | "success" | "warning" | "info";
export type HeadingLevel = 1 | 2 | 3;
export type TextVariant = "body" | "secondary" | "caption" | "helper";

const HEADING_STYLES: Record<HeadingLevel, string> = {
  1: "type-h1",
  2: "type-h2",
  3: "type-h3",
};

const TEXT_STYLES: Record<TextVariant, string> = {
  body: "type-body",
  secondary: "type-secondary",
  caption: "type-caption",
  helper: "type-caption",
};

const DEFAULT_TEXT_COLORS: Record<TextVariant, string> = {
  body: "text-text",
  secondary: "text-text-2",
  caption: "text-text-3",
  helper: "text-text-3",
};

const TONE_STYLES: Record<Exclude<TypographyTone, "default">, string> = {
  danger: "text-danger-text",
  success: "text-success-text",
  warning: "text-fire-text",
  info: "text-info-text",
};

function toneClassName(tone: TypographyTone, fallback: string) {
  return tone === "default" ? fallback : TONE_STYLES[tone];
}

export interface HeadingProps extends React.HTMLAttributes<HTMLHeadingElement> {
  level?: HeadingLevel;
  tone?: TypographyTone;
}

/** Семантический заголовок с единой визуальной ролью для всей платформы. */
export function Heading({ level = 2, tone = "default", className, ...props }: HeadingProps) {
  const shared = cn(
    HEADING_STYLES[level],
    toneClassName(tone, "text-text"),
    className,
  );

  if (level === 1) return <h1 data-typography="h1" className={shared} {...props} />;
  if (level === 2) return <h2 data-typography="h2" className={shared} {...props} />;
  return <h3 data-typography="h3" className={shared} {...props} />;
}

export function H1(props: Omit<HeadingProps, "level">) {
  return <Heading level={1} {...props} />;
}

export function H2(props: Omit<HeadingProps, "level">) {
  return <Heading level={2} {...props} />;
}

export function H3(props: Omit<HeadingProps, "level">) {
  return <Heading level={3} {...props} />;
}

type TextElement = "p" | "span" | "div" | "small";

export interface TextProps extends React.HTMLAttributes<HTMLElement> {
  as?: TextElement;
  variant?: TextVariant;
  tone?: TypographyTone;
}

/** Основной, дополнительный и служебный текст из одной semantic scale. */
export function Text({
  as: Tag = "p",
  variant = "body",
  tone = "default",
  className,
  ...props
}: TextProps) {
  return (
    <Tag
      data-typography={variant}
      className={cn(
        TEXT_STYLES[variant],
        toneClassName(tone, DEFAULT_TEXT_COLORS[variant]),
        className,
      )}
      {...props}
    />
  );
}

export function BodyText(props: Omit<TextProps, "variant">) {
  return <Text variant="body" {...props} />;
}

export function SecondaryText(props: Omit<TextProps, "variant">) {
  return <Text variant="secondary" {...props} />;
}

export function Caption(props: Omit<TextProps, "variant">) {
  return <Text variant="caption" {...props} />;
}

export function HelperText(props: Omit<TextProps, "variant">) {
  return <Text variant="helper" {...props} />;
}
