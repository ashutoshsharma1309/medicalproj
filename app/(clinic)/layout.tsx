import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { AppShell } from "@/components/shell/AppShell";

export default async function ClinicLayout({ children }: { children: React.ReactNode }) {
  const user = await getSession();
  if (!user) redirect("/login");
  if (user.role !== "DOCTOR") redirect(user.role === "ADMIN" ? "/admin" : "/portal");
  return <AppShell user={user}>{children}</AppShell>;
}
