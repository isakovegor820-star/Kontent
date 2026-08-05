// Вся платформа живёт в той же Aurora Glass-системе, что и главный лендинг.
// Скоуп оставляем прежним, чтобы визуальные правила не задевали публичные страницы.
import "./app-v3.css";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <div className="app-v3">{children}</div>;
}
