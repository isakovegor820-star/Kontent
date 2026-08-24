import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Подтверждение почты",
  robots: { index: false, follow: false },
};

export default function ConfirmEmailLayout({ children }: { children: React.ReactNode }) {
  return children;
}
