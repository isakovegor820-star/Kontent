import type { Metadata } from "next";
import { v3Display, v3Kinetic, v3Mono } from "../v3/fonts";
import "../v3/v3.css";
import "../variants/variants.css";
import "../reasons/reasons.css";

export const metadata: Metadata = {
  title: { absolute: "Аврора — три финальные scroll-сцены" },
  description: "Три интерактивных варианта финального блока лендинга Авроры.",
};

export default function FinaleVariantsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className={`v3 ${v3Display.variable} ${v3Mono.variable} ${v3Kinetic.variable}`}>
      <div className="v3-paper min-h-dvh">{children}</div>
    </div>
  );
}
