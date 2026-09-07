import type { Metadata } from "next";
import { AdminWorkspaceLayout } from "@/components/admin/admin-workspace-layout";

import "../app/app-v3.css";
import "./admin.css";

export const metadata: Metadata = {
  title: "Пульс Авроры",
  description: "Защищённый операционный центр платформы Аврора.",
};

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return <AdminWorkspaceLayout>{children}</AdminWorkspaceLayout>;
}
