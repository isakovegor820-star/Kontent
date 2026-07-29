// Layout алиаса /v3: только метаданные. Страница (src/app/page.tsx) сама несёт
// .v3-скоуп, шрифты (v3Display/v3Mono) и v3.css — обёртка здесь больше не нужна.
import type { Metadata } from "next";

export const metadata: Metadata = {
  // absolute — иначе шаблон корневого layout доклеит « · Аврора» второй раз
  title: { absolute: "Аврора — канал ведётся сам" },
  description:
    "Автопилот для Telegram-каналов: разведка конкурентов, ИИ-посты твоим голосом и публикация по расписанию. Бесплатно на старте. Без карты.",
};

export default function V3Layout({ children }: { children: React.ReactNode }) {
  return children;
}
