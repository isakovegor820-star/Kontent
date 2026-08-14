import type { Metadata } from "next";

export const metadata: Metadata = {
  title: { absolute: "Аврора — технологичные SMM-концепции" },
  description:
    "Пять технологичных интерактивных вариантов блока о полном SMM-цикле Авроры.",
};

export default function CycleLayout({ children }: { children: React.ReactNode }) {
  return children;
}
