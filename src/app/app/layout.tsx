// Layout платформы: небрутализм v3 внутри приложения.
// Подключает шрифты мира v3 (Unbounded + Plex Mono), саму v3-систему
// (классы .v3-btn/.v3-chip/.v3-paper работают и здесь) и токен-мост app-v3.css,
// который перекрашивает семантические токены Aurora Glass под скоупом .app-v3.
// Старый лендинг снаружи скоупа не затрагивается.
import { v3Display, v3Mono } from "../v3/fonts";
import "../v3/v3.css";
import "./app-v3.css";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <div className={`app-v3 ${v3Display.variable} ${v3Mono.variable}`}>{children}</div>;
}
