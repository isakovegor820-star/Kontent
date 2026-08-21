import type { Metadata } from "next";
import { ReferenceLanding } from "@/components/landing/reference-landing";

export const metadata: Metadata = {
  title: { absolute: "Аврора — контент из реальных сигналов" },
  description:
    "Аврора находит, что сработало в вашей нише, объясняет почему и готовит оригинальный материал для Telegram — с источниками, контролем версии и публикацией после одобрения.",
};

export default function LandingPage() {
  return <ReferenceLanding />;
}
