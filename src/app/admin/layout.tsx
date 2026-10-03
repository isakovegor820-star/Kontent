import type { Metadata } from "next";

import { LegalLinks } from "@/components/legal/legal-links";
import "../app/app-v3.css";
import "./admin.css";

export const metadata: Metadata = {
  title: "Пульс Авроры",
  description: "Защищённый операционный центр платформы Аврора.",
};

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="app-v3 admin-workspace">
      {children}
      {/* Админка тоже работает с персональными данными пользователей: доступ
          к политике и согласию обязателен и здесь. */}
      <footer className="mx-auto w-full max-w-[1400px] px-4 pb-8 sm:px-6 lg:px-8">
        <LegalLinks
          className="flex flex-wrap gap-x-4 gap-y-2 border-t border-line pt-4 text-[12px]"
          linkClassName="text-text-3 underline decoration-1 underline-offset-2 transition-colors hover:text-text-2"
        />
      </footer>
    </div>
  );
}
