import type { Metadata } from "next";
import { v3Display, v3Mono } from "../v3/fonts";
import "../v3/v3.css";
import "../variants/variants.css";
import "./reasons.css";

export const metadata: Metadata = {
  title: { absolute: "Аврора - варианты блока причин" },
  description: "Три варианта блока о причинах, по которым каналы стоят.",
};

export default function ReasonsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className={`v3 ${v3Display.variable} ${v3Mono.variable}`}>
      <div className="v3-paper min-h-dvh">{children}</div>
    </div>
  );
}
