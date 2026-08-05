import type { Metadata } from "next";
import { v3Display, v3Kinetic, v3Mono } from "../v3/fonts";
import "../v3/v3.css";

export const metadata: Metadata = {
  title: "10 вариантов блока «Память канала»",
  description: "Десять дизайн-концепций блока памяти для лендинга Авроры.",
};

export default function MemoryLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className={`v3 ${v3Display.variable} ${v3Mono.variable} ${v3Kinetic.variable}`}>
      {children}
    </div>
  );
}
