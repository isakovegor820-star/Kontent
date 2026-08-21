import type { Viewport } from "next";
import "./app-v3.css";
import { ProjectProvider } from "@/components/app/project-provider";

// Системные панели браузера продолжают чёрную рабочую поверхность платформы.
export const viewport: Viewport = {
  colorScheme: "dark",
  themeColor: "#070a10",
};

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <ProjectProvider><div className="app-v3">{children}</div></ProjectProvider>;
}
