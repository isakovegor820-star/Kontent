// Метаданные архивной необруталистичной версии от 28 июля.
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
