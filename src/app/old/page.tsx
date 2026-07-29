// АРХИВ: прежний лендинг (Aurora Glass, фиолет), 2026-07-28 уступил / необрутализму v3.
// Сохранён по решению владельца «старые можно оставить». Порядок секций — по ТЗ 8.1.
// Логика владельца: сначала ОБЪЯСНЯЕМ, что это и как пользоваться, и только потом ведём на регистрацию.

import { LandingNav } from "@/components/landing/nav";
import { Hero } from "@/components/landing/hero";
import { Pains } from "@/components/landing/pains";
import { Cycle } from "@/components/landing/cycle";
import { HowTo } from "@/components/landing/howto";
import { Compare } from "@/components/landing/compare";
import { Faq } from "@/components/landing/faq";
import { FinalCta, Footer } from "@/components/landing/final-cta";
import { StickyCta } from "@/components/landing/sticky-cta";

export default function OldLandingPage() {
  return (
    <>
      <LandingNav />
      <main id="main">
        {/* 1. Hero — живое демо */}
        <Hero />
        {/* 2. Боль → решение */}
        <Pains />
        {/* 3. Цикл работы по шагам */}
        <Cycle />
        {/* 4. Как пользоваться — 3 шага */}
        <HowTo />
        {/* 5. Сравнение с конкурентами */}
        <Compare />
        {/* Возражения — закрываем базовые вопросы покупателя до регистрации */}
        <Faq />
        {/* 6. Финальный призыв + запасной путь в лист ожидания */}
        <FinalCta />
      </main>
      <Footer />
      {/* Главное действие всегда под рукой на телефоне — там кнопки в шапке нет */}
      <StickyCta />
    </>
  );
}
