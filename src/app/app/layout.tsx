import type { Viewport } from "next";
import { cookies } from "next/headers";
import "./app-v3.css";
import { ProjectProvider } from "@/components/app/project-provider";
import { AuroraProductTelemetry } from "@/components/app/aurora-product-telemetry";
import { AppThemeProvider } from "@/components/app/theme-provider";
import { APP_THEME_COOKIE, normalizeAppThemePreference } from "@/lib/app-theme";

// Платформа поддерживает обе схемы; конкретный цвет browser chrome синхронизирует provider.
export const viewport: Viewport = {
  colorScheme: "light dark",
  themeColor: "#070a10",
};

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const preference = normalizeAppThemePreference(
    (await cookies()).get(APP_THEME_COOKIE)?.value,
  );

  return (
    <ProjectProvider>
      <AppThemeProvider initialPreference={preference}>
        <AuroraProductTelemetry />
        {children}
      </AppThemeProvider>
    </ProjectProvider>
  );
}
