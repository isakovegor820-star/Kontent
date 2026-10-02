import type { Metadata } from "next";

/**
 * Каркас страницы закрыт от индексации до утверждения текста юристом.
 * После утверждения: снять `robots` здесь и добавить путь в `PUBLIC_ROUTES`
 * (`src/lib/seo/public-routes.ts`) — sitemap подхватит автоматически.
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function ConsentLayout({ children }: { children: React.ReactNode }) {
  return children;
}
