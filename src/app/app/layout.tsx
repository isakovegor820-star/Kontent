// Вся платформа живёт в той же Aurora Glass-системе, что и главный лендинг.
// Скоуп оставляем прежним, чтобы визуальные правила не задевали публичные страницы.
import "./app-v3.css";
import { ProjectProvider } from "@/components/app/project-provider";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <ProjectProvider><div className="app-v3">{children}</div></ProjectProvider>;
}
