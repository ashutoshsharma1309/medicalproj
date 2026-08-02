import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { checkMedicationSafety } from "@/lib/clinical/interactions";
import { z } from "zod";

const Body = z.object({
  patientId: z.string(),
  proposedDrug: z.string().optional(),
});

export async function POST(req: NextRequest) {
  const guard = await requireRole("DOCTOR", "ADMIN");
  if ("error" in guard) return guard.error;

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "patientId is required." }, { status: 400 });

  const patient = await db.patient.findUnique({
    where: { id: parsed.data.patientId },
    include: { medications: true, allergies: true },
  });
  if (!patient) return NextResponse.json({ error: "Patient not found." }, { status: 404 });

  const alerts = await checkMedicationSafety(
    patient.medications,
    patient.allergies,
    parsed.data.proposedDrug ? { name: parsed.data.proposedDrug } : undefined,
  );

  audit({
    userId: guard.user.id,
    action: "meds.safety_check",
    resource: `patient:${patient.id}`,
    detail: `${alerts.length} alert(s)${parsed.data.proposedDrug ? `, proposed: ${parsed.data.proposedDrug}` : ""}`,
  });

  return NextResponse.json({ alerts });
}
