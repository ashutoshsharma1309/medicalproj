import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { AppShell } from "@/components/shell/AppShell";

export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const user = await getSession();
  if (!user) redirect("/login");
  if (user.role !== "PATIENT") redirect(user.role === "DOCTOR" ? "/dashboard" : "/admin");
  return <AppShell user={user}>{children}</AppShell>;
}
