import type { Metadata } from "next";
import { ReferenceLanding } from "@/components/landing/reference-landing";

export const metadata: Metadata = {
  title: { absolute: "Аврора — юридический контент с проверкой рисков" },
  description:
    "Планируйте юридический контент, фиксируйте источники и доказательства, согласовывайте версии и публикуйте готовые материалы в Telegram.",
};

export default function LandingPage() {
  return <ReferenceLanding />;
}
