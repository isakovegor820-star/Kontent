import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Подключить Telegram",
  description: "Безопасно свяжите личный Telegram-чат с аккаунтом Авроры.",
};

export default function BotConnectLayout({ children }: { children: React.ReactNode }) {
  return children;
}
