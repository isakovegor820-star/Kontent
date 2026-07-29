// Layout экрана входа: тот же небруталистский скоуп .app-v3, что и платформа, —
// регистрация визуально продолжает лендинг v3, а не старый «стеклянный» мир.
import { v3Display, v3Mono } from "../v3/fonts";
import "../v3/v3.css";
import "../app/app-v3.css";

export default function RegisterLayout({ children }: { children: React.ReactNode }) {
  return <div className={`app-v3 ${v3Display.variable} ${v3Mono.variable}`}>{children}</div>;
}
