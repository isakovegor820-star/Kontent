import type { Metadata, Viewport } from "next";
import { connection } from "next/server";
import { StoreProvider } from "@/lib/store";
import { Toaster } from "@/components/ui/toaster";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Аврора — Content Intelligence для Telegram",
    template: "%s · Аврора",
  },
  description:
    "Аврора превращает реальные сигналы вашей ниши в оригинальные, проверяемые публикации для Telegram.",
  icons: {
    icon: "/icon.svg",
    shortcut: "/icon.svg",
  },
  keywords: ["Content Intelligence", "Telegram", "анализ конкурентов", "автопостинг", "ИИ-контент"],
  openGraph: {
    title: "Аврора — Content Intelligence для Telegram",
    description:
      "От проверенного сигнала до оригинального материала и подтверждённой публикации — в одном рабочем цикле.",
    locale: "ru_RU",
    type: "website",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  // Системные панели браузера продолжают фирменный цвет продукта.
  themeColor: "#2563ff",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // A fresh CSP nonce is generated per document request. Waiting for the request here
  // keeps framework scripts and styles nonce-bound instead of serving a static shell
  // whose build-time markup cannot carry that nonce.
  await connection();
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
