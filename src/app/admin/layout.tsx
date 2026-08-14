import type { Metadata } from "next";

import "../app/app-v3.css";

export const metadata: Metadata = {
  title: "Пульс Авроры",
  description: "Защищённый операционный центр платформы Аврора.",
};

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return <div className="app-v3">{children}</div>;
}
