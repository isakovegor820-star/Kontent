import type { Metadata } from "next";
import { v3Display, v3Kinetic, v3Mono } from "../v3/fonts";
import "../v3/v3.css";

export const metadata: Metadata = {
  title: "10 вариантов контроля качества",
  description: "Минималистичные дизайн-концепции контроля качества Авроры.",
};

export default function QualityLayout({ children }: { children: React.ReactNode }) {
  return <div className={`v3 ${v3Display.variable} ${v3Mono.variable} ${v3Kinetic.variable}`}>{children}</div>;
}
