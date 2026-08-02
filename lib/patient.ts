import { NextResponse } from "next/server";
import { db } from "./db";
import { getSession, type SessionUser } from "./auth";

/**
 * Patient-portal guard: authenticated + PATIENT role, plus the caller's own
 * Patient record (null until onboarding creates it). All portal APIs go
 * through this so a patient can only ever touch their own record.
 */
export async function requirePatient(): Promise<
  | { user: SessionUser; patient: Awaited<ReturnType<typeof findPatient>> }
  | { error: NextResponse }
> {
  const user = await getSession();
  if (!user) {
    return {
      error: NextResponse.json({ error: "Not authenticated. Sign in to continue." }, { status: 401 }),
    };
  }
  if (user.role !== "PATIENT") {
    return {
      error: NextResponse.json(
        { error: "This area is for patient accounts." },
        { status: 403 },
      ),
    };
  }
  return { user, patient: await findPatient(user.id) };
}

function findPatient(userId: string) {
  return db.patient.findFirst({ where: { userId } });
}

export async function generateMrn(): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const candidate = `MRN-${Math.floor(100000 + Math.random() * 900000)}`;
    const exists = await db.patient.findUnique({ where: { mrn: candidate } });
    if (!exists) return candidate;
  }
  return `MRN-${Date.now()}`;
}
