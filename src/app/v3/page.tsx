// Архив утверждённой 28 июля версии: прежний hero с интерактивным пультом.
// Корневая страница теперь использует вариант 4, поэтому /v3 остаётся независимым маршрутом.
import { V3Faq } from "@/components/v3/faq";
import { V3FinalCta, V3Footer } from "@/components/v3/final-cta";
import { V3Facts } from "@/components/v3/facts";
import { V3Hero } from "@/components/v3/hero";
import { V3Ledger } from "@/components/v3/ledger";
import { V3Nav } from "@/components/v3/nav";
import { V3PostProof } from "@/components/v3/post-proof";
import { V3Pricing } from "@/components/v3/pricing";
import { V3QualityScanner } from "@/components/v3/quality-scanner";
import { V3StickyCta } from "@/components/v3/sticky-cta";
import { V3Tabs } from "@/components/v3/tabs";
import { V3Ticker } from "@/components/v3/ticker";
import { v3Display, v3Mono } from "./fonts";
import "./v3.css";

export default function ArchivedV3Page() {
  return (
    <div className={`v3 ${v3Display.variable} ${v3Mono.variable}`}>
      <div className="v3-paper min-h-dvh">
        <div className="v3-grain" aria-hidden />
        <V3Nav />
        <main id="main">
          <V3Hero />
          <V3Ticker />
          <V3Facts />
          <V3Ledger />
          <V3Tabs />
          <V3PostProof />
          <V3QualityScanner />
          <V3Pricing />
          <V3Faq legacyPricing />
          <V3FinalCta legacyPricing />
        </main>
        <V3Footer legacyPricing />
        <V3StickyCta />
      </div>
    </div>
  );
}
