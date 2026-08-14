import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Создать аккаунт",
  description: "Зарегистрируйтесь в Авроре и перейдите в рабочую SMM-платформу.",
};

export default function RegisterLayout({ children }: { children: React.ReactNode }) {
  return children;
}
