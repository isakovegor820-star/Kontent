// ГЛАВНЫЙ ЛЕНДИНГ (2026-07-28): необрутализм v3 утверждён основным.
// Кремовая бумага, чёрные рамки, жёсткие тени, один сигнальный жёлтый.
// Старый фиолетовый лендинг сохранён на /old, эксперимент v2 — на /v2.
// Страница самодостаточна: сама несёт .v3-скоуп, свои шрифты и v3.css,
// поэтому алиас /v3 просто реэкспортирует её (src/app/v3/page.tsx).
import type { Metadata } from "next";
import { v3Display, v3Mono } from "./v3/fonts";
import "./v3/v3.css";
import { V3Nav } from "@/components/v3/nav";
import { V3Hero } from "@/components/v3/hero";
import { V3Ticker } from "@/components/v3/ticker";
import { V3Facts } from "@/components/v3/facts";
import { V3Ledger } from "@/components/v3/ledger";
import { V3Tabs } from "@/components/v3/tabs";
import { V3PostProof } from "@/components/v3/post-proof";
import { V3Compare } from "@/components/v3/compare";
import { V3Pricing } from "@/components/v3/pricing";
import { V3Faq } from "@/components/v3/faq";
import { V3FinalCta, V3Footer } from "@/components/v3/final-cta";
import { V3StickyCta } from "@/components/v3/sticky-cta";

export const metadata: Metadata = {
  // absolute — иначе шаблон корневого layout доклеит « · Аврора» второй раз
  title: { absolute: "Аврора — канал ведётся сам" },
  description:
    "Автопилот для Telegram-каналов: разведка конкурентов, ИИ-посты твоим голосом и публикация по расписанию. Бесплатно на старте. Без карты.",
};

export default function LandingPage() {
  return (
    <div className={`v3 ${v3Display.variable} ${v3Mono.variable}`}>
      <div className="v3-paper min-h-dvh">
        <div className="v3-grain" aria-hidden />
        <V3Nav />
        <main id="main">
          {/* 1. Hero + пульт-демо по клику */}
          <V3Hero />
          {/* 2. Тикер формулы */}
          <V3Ticker />
          {/* 3. Факты-полоса */}
          <V3Facts />
          {/* 4. Боли → решения: реестр БЫЛО/СТАЛО */}
          <V3Ledger />
          {/* 5. Центральный таб-блок «Как это работает» */}
          <V3Tabs />
          {/* 6. Соцдоказательство: пост, который написала Аврора */}
          <V3PostProof />
          {/* 7. Сравнение с конкурентами */}
          <V3Compare />
          {/* 8. Тарифы: Free + Pro-плейсхолдер */}
          <V3Pricing />
          {/* 9. Вопросы и возражения */}
          <V3Faq />
          {/* 10. Финальный призыв + лист ожидания */}
          <V3FinalCta />
        </main>
        <V3Footer />
        <V3StickyCta />
      </div>
    </div>
  );
}
