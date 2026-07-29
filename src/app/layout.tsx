import type { Metadata, Viewport } from "next";
import { Golos_Text, JetBrains_Mono } from "next/font/google";
import { StoreProvider } from "@/lib/store";
import { Toaster } from "@/components/ui/toaster";
import "./globals.css";

// Golos Text — выбор ТЗ 7.3: отличная кириллица, свободная лицензия
const golos = Golos_Text({
  subsets: ["latin", "cyrillic"],
  display: "swap",
  variable: "--font-golos",
});

// Моно — только для цифр и метрик, чтобы они не «прыгали»
const jetbrains = JetBrains_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-jetbrains",
});

export const metadata: Metadata = {
  title: {
    default: "Аврора — соцсети, которые ведут себя сами",
    template: "%s · Аврора",
  },
  description:
    "Разведка конкурентов, залетающие темы, ИИ-контент в твоём стиле и автопостинг в Telegram и VK. Бесплатно. Без карты. Из России.",
  keywords: ["автопостинг", "Telegram", "VK", "SMM", "ИИ-контент", "разведка конкурентов"],
  openGraph: {
    title: "Аврора — соцсети, которые ведут себя сами",
    description:
      "Разведка → ИИ-контент → автопостинг → реакции. Замкнутого круга нет ни у одного конкурента.",
    locale: "ru_RU",
    type: "website",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Продукт однотонный — кремовая бумага; тёмной темы больше нет
  themeColor: "#f4f0ea",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="ru"
      className={`${golos.variable} ${jetbrains.variable}`}
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
