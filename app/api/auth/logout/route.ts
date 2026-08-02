import { NextResponse } from "next/server";
import { destroySession, getSession } from "@/lib/auth";
import { audit } from "@/lib/audit";

export async function POST() {
  const user = await getSession();
  if (user) audit({ userId: user.id, action: "auth.logout" });
  await destroySession();
  return NextResponse.json({ ok: true });
}
