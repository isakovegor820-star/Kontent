// ГЛАВНЫЙ ЛЕНДИНГ (2026-07-29): утверждён вариант 4.
// Старый необруталистичный hero сохранён на /v3, экспериментальные версии — на /variants/*.
import type { Metadata } from "next";
import { VariantLanding } from "@/components/v3/variants/landing";
import { v3Display, v3Kinetic, v3Mono } from "./v3/fonts";
import "./v3/v3.css";
import "./variants/variants.css";
import "./reasons/reasons.css";

export const metadata: Metadata = {
  title: { absolute: "Аврора — ты задаёшь тон, Аврора ведёт канал" },
  description:
    "Аврора находит сильные темы, готовит материалы твоим голосом и публикует их в Telegram. Факты — из базы знаний, подача — из твоего канала.",
};

export default function LandingPage() {
  return (
    <div className={`v3 ${v3Display.variable} ${v3Mono.variable} ${v3Kinetic.variable}`}>
      <div className="v3-paper min-h-dvh">
        <VariantLanding
          variant={4}
          showSwitcher={false}
          reasonsVariant={2}
          showReasonsSwitcher={false}
          footerVariant={3}
          footerInteractionVariant={3}
          enableScrollMotion
          finaleVariant={2}
          showFinaleSwitcher={false}
        />
      </div>
    </div>
  );
}
