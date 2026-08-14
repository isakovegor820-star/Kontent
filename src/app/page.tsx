import type { Metadata } from "next";
import { ReferenceLanding } from "@/components/landing/reference-landing";

export const metadata: Metadata = {
  title: { absolute: "Аврора — центр управления SMM" },
  description:
    "Планируйте контент, управляйте соцсетями, работайте с командой и анализируйте результат в одной SMM-платформе.",
};

export default function LandingPage() {
  return <ReferenceLanding />;
}
