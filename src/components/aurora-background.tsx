"use client";

// Фирменный фон «Аврора»: дрейфующие пятна света + строгая сетка + плёночное зерно.
// Всё на CSS-трансформах → GPU, не грузит основной поток (ТЗ 8.2: <2 сек на телефоне).
// Ни одной картинки — фон весит 0 КБ и не создаёт layout shift.

import { cn } from "@/lib/utils";

type Intensity = "hero" | "section" | "app";

export function AuroraBackground({
  intensity = "section",
  grid = true,
  grain = true,
  className,
}: {
  intensity?: Intensity;
  grid?: boolean;
  grain?: boolean;
  className?: string;
}) {
  // Рабочие экраны — спокойные (ТЗ 7.1), лендинг — яркий
  const scale = intensity === "hero" ? 1 : intensity === "section" ? 0.55 : 0.28;

  return (
    <div
      aria-hidden="true"
      className={cn("pointer-events-none absolute inset-0 overflow-hidden", className)}
      style={{ opacity: `calc(var(--aurora-opacity) * ${scale})` }}
    >
      {/* Индиго — левый верх */}
      <div
        className="aurora-blob"
        style={{
          top: "-18%",
          left: "-12%",
          width: "58vw",
          height: "58vw",
          maxWidth: 900,
          maxHeight: 900,
          background:
            "radial-gradient(circle at 30% 30%, rgb(99 102 241 / 0.85), rgb(99 102 241 / 0) 68%)",
          animation: "aurora-a 26s ease-in-out infinite",
        }}
      />
      {/* Фиолетовый — правый верх */}
      <div
        className="aurora-blob"
        style={{
          top: "-10%",
          right: "-14%",
          width: "52vw",
          height: "52vw",
          maxWidth: 820,
          maxHeight: 820,
          background:
            "radial-gradient(circle at 60% 40%, rgb(139 92 246 / 0.8), rgb(139 92 246 / 0) 68%)",
          animation: "aurora-b 32s ease-in-out infinite",
        }}
      />
      {/* Янтарный — «залёт». Тёплое пятно снизу слева, редкий акцент */}
      <div
        className="aurora-blob"
        style={{
          bottom: "-22%",
          left: "8%",
          width: "40vw",
          height: "40vw",
          maxWidth: 620,
          maxHeight: 620,
          background:
            "radial-gradient(circle at 50% 50%, rgb(245 158 11 / 0.42), rgb(245 158 11 / 0) 66%)",
          animation: "aurora-c 38s ease-in-out infinite",
        }}
      />
      {/* Изумрудный — «успех». Совсем тихо, справа снизу */}
      <div
        className="aurora-blob"
        style={{
          bottom: "-16%",
          right: "2%",
          width: "34vw",
          height: "34vw",
          maxWidth: 520,
          maxHeight: 520,
          background:
            "radial-gradient(circle at 50% 50%, rgb(16 185 129 / 0.34), rgb(16 185 129 / 0) 66%)",
          animation: "aurora-a 30s ease-in-out infinite reverse",
        }}
      />

      {grid && <div className="grid-skeleton absolute inset-0" />}
      {grain && <div className="grain" />}
    </div>
  );
}
