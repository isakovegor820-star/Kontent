import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Вход",
  description: "Войдите в рабочее пространство Авроры.",
  robots: { index: false, follow: false },
};

export default function LoginLayout({ children }: { children: React.ReactNode }) {
  return children;
}
