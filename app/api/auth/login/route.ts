import { NextRequest, NextResponse } from "next/server";
import { verifyCredentials, createSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { z } from "zod";

const Body = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  remember: z.boolean().optional(),
});

export async function POST(req: NextRequest) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Enter a valid email and password." }, { status: 400 });
  }
  const user = await verifyCredentials(parsed.data.email, parsed.data.password);
  if (!user) {
    audit({ action: "auth.login_failed", detail: parsed.data.email });
    return NextResponse.json({ error: "Email or password is incorrect." }, { status: 401 });
  }
  await createSession(user, { remember: parsed.data.remember });
  audit({ userId: user.id, action: "auth.login", detail: user.role });

  let dest = user.role === "DOCTOR" ? "/dashboard" : user.role === "ADMIN" ? "/admin" : "/portal";
  if (user.role === "PATIENT") {
    // First login after signup → medical profile onboarding
    const profile = await db.patient.findFirst({ where: { userId: user.id } });
    if (!profile || !profile.profileCompleted) dest = "/portal/setup";
  }
  return NextResponse.json({ ok: true, redirect: dest });
}
