// Layout прототипа v2: подключает свои шрифты и свою дизайн-систему (v2.css),
// всё scoped под классом .v2 — боевые страницы не затрагиваются.
import { v2Display, v2Mono } from "./fonts";
import "./v2.css";

export default function V2Layout({ children }: { children: React.ReactNode }) {
  return <div className={`v2 ${v2Display.variable} ${v2Mono.variable}`}>{children}</div>;
}
