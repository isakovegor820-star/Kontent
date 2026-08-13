import type { Metadata, Viewport } from "next";
import { StoreProvider } from "@/lib/store";
import { Toaster } from "@/components/ui/toaster";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Аврора — SMM-платформа для юридического бизнеса",
    template: "%s · Аврора",
  },
  description:
    "Аврора помогает юридическому бизнесу создавать, согласовывать и публиковать контент в социальных сетях.",
  icons: {
    icon: "/icon.svg",
    shortcut: "/icon.svg",
  },
  keywords: ["юридический SMM", "автопостинг", "Telegram", "VK", "ИИ-контент"],
  openGraph: {
    title: "Аврора — SMM-платформа для юридического бизнеса",
    description:
      "Контент, согласование, календарь и публикация для юридических команд — в одном рабочем цикле.",
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
