import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Восстановление пароля",
  description: "Запросите одноразовую ссылку для восстановления доступа к Авроре.",
  robots: { index: false, follow: false },
};

export default function ForgotPasswordLayout({ children }: { children: React.ReactNode }) {
  return children;
}
