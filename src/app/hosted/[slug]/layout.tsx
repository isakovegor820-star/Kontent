import type { ReactNode } from "react";

/**
 * Хостируемый раздел клиента: отдельный публичный слой без интерфейса Авроры.
 * Разметка семантическая и лёгкая — это страницы для поиска и генеративных движков,
 * а не для авторизованного пользователя продукта.
 */
export default function HostedSectionLayout({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto min-h-screen w-full max-w-3xl px-5 py-10 text-[16px] leading-relaxed text-text sm:px-8">
      {children}
    </div>
  );
}
