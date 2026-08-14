import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Войти",
  description: "Войдите в Аврору и продолжите работу в SMM-платформе.",
};

export default function LoginLayout({ children }: { children: React.ReactNode }) {
  return children;
}
