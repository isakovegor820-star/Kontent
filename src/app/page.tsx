import type { Metadata } from "next";
import { LandingNav } from "@/components/landing/nav";
import { Hero } from "@/components/landing/hero";
import { Pains } from "@/components/landing/pains";
import { Cycle } from "@/components/landing/cycle";
import { HowTo } from "@/components/landing/howto";
import { ChannelMemory, QualityControl } from "@/components/landing/capabilities";
import { Compare } from "@/components/landing/compare";
import { Faq } from "@/components/landing/faq";
import { FinalCta, Footer } from "@/components/landing/final-cta";
import { StickyCta } from "@/components/landing/sticky-cta";

export const metadata: Metadata = {
  title: { absolute: "Аврора — SMM-платформа для юридического бизнеса" },
  description:
    "Создавайте, согласовывайте и публикуйте юридический контент в социальных сетях вместе с Авророй.",
};

export default function LandingPage() {
  return (
    <>
      <LandingNav />
      <main id="main">
        <Hero />
        <Pains />
        <Cycle />
        <HowTo />
        <ChannelMemory />
        <QualityControl />
        <Compare />
        <Faq />
        <FinalCta />
      </main>
      <Footer />
      <StickyCta />
    </>
  );
}
