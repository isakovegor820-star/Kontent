import type { Metadata, Viewport } from "next";
import { StoreProvider } from "@/lib/store";
import { Toaster } from "@/components/ui/toaster";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Аврора — автопилот для Telegram-каналов",
    template: "%s · Аврора",
  },
  description:
    "Аврора находит сильные темы, пишет посты в голосе канала, проверяет и публикует их в Telegram по расписанию.",
  icons: {
    icon: "/icon.svg",
    shortcut: "/icon.svg",
  },
  keywords: ["автопостинг", "Telegram", "SMM", "ИИ-контент", "разведка конкурентов"],
  openGraph: {
    title: "Аврора — автопилот для Telegram-каналов",
    description:
      "Темы, материалы в твоём голосе, проверка и публикация с сервера — в одном редакционном цикле.",
    locale: "ru_RU",
    type: "website",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  // Продукт однотонный — кремовая бумага; тёмной темы больше нет
  themeColor: "#f4f0ea",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="ru"
      className="aurora-system-fonts"
      suppressHydrationWarning
      data-scroll-behavior="smooth"
    >
      <body className="font-sans">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-[100] focus:rounded-lg focus:bg-[#0a0a0a] focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-white focus:shadow-lg"
        >
          Перейти к содержимому
        </a>
        <StoreProvider>
          {children}
          <Toaster />
        </StoreProvider>
      </body>
    </html>
  );
}
