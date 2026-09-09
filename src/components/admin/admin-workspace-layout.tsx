"use client";

import { usePathname } from "next/navigation";

/** The public login keeps the shared light auth surface outside workspace CSS. */
export function AdminWorkspaceLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  if (pathname === "/admin/login") return <>{children}</>;
  return <div className="app-v3 admin-workspace">{children}</div>;
}
