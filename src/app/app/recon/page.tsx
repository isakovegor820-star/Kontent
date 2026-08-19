import { redirect } from "next/navigation";

export default function ReconPage() {
  redirect("/app/trends?scope=internet");
}
