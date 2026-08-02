import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { AppShell } from "@/components/shell/AppShell";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await getSession();
  if (!user) redirect("/login");
  if (user.role !== "ADMIN") redirect(user.role === "DOCTOR" ? "/dashboard" : "/portal");
  return <AppShell user={user}>{children}</AppShell>;
}
