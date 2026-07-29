// ПРОТОТИП V2 — редакционный лендинг: бумага, чернила, киноварь.
// Мастхед живёт внутри HeroFlip: в flip-режиме он абсолютно позиционирован
// в sticky-сцене, чтобы сцена начиналась от y=0 и липкий блок был включён
// с первого пикселя (иначе подсказка и HUD проваливались под фолд).
import { HeroFlip } from "@/components/v2/hero-flip";
import { Annotations } from "@/components/v2/annotations";

export default function V2Page() {
  return (
    <div className="v2-paper min-h-dvh">
      <div className="v2-grain" aria-hidden />
      <main>
        <HeroFlip />
        <Annotations />
      </main>
    </div>
  );
}
