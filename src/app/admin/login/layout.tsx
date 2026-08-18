import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Вход в центр управления",
  description: "Защищённый вход для администраторов Авроры.",
};

export default function AdminLoginLayout({ children }: { children: React.ReactNode }) {
  return children;
}
