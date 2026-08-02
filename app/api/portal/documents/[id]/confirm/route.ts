import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { requirePatient } from "@/lib/patient";
import type { PatientExtraction } from "@/lib/ai/patientExtraction";

/**
 * Verification step: the patient reviewed the extracted information and
 * chose "Confirm and save". Extracted facts are merged into the profile
 * additively — nothing already on file is overwritten or removed.
 */
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requirePatient();
  if ("error" in guard) return guard.error;

  const { id } = await ctx.params;
  const doc = await db.document.findUnique({ where: { id } });
  if (!doc || !guard.patient || doc.patientId !== guard.patient.id) {
    return NextResponse.json({ error: "Document not found." }, { status: 404 });
  }
  if (!doc.extraction || doc.extractionStatus !== "EXTRACTED") {
    return NextResponse.json(
      { error: "This document has no extraction awaiting review." },
      { status: 409 },
    );
  }

  const ex = doc.extraction as unknown as PatientExtraction;
  const patient = await db.patient.findUnique({
    where: { id: guard.patient.id },
    include: { conditions: true, allergies: true, medications: true },
  });

  const applied: string[] = [];
  const has = (list: { name?: string; substance?: string }[], v: string) =>
    list.some((x) => (x.name ?? x.substance ?? "").toLowerCase() === v.toLowerCase());

  // Fill blood group only if the profile doesn't have one yet.
  if (!patient!.bloodType && ex.bloodGroup) {
    await db.patient.update({ where: { id: patient!.id }, data: { bloodType: ex.bloodGroup } });
    applied.push(`Blood group ${ex.bloodGroup}`);
  }

  for (const c of ex.conditions ?? []) {
    if (!has(patient!.conditions, c)) {
      await db.condition.create({
        data: { patientId: patient!.id, name: c, status: "ACTIVE", diagnosedAt: new Date(), notes: `From document "${doc.filename}", confirmed by patient.` },
      });
      applied.push(`Condition: ${c}`);
    }
  }
  for (const a of ex.allergies ?? []) {
    if (!has(patient!.allergies, a)) {
      await db.allergy.create({
        data: { patientId: patient!.id, substance: a, reaction: "From uploaded document", severity: "MEDIUM" },
      });
      applied.push(`Allergy: ${a}`);
    }
  }
  for (const m of ex.medications ?? []) {
    if (m.name && !has(patient!.medications, m.name)) {
      await db.medication.create({
        data: {
          patientId: patient!.id,
          name: m.name,
          genericName: m.name.toLowerCase(),
          dose: m.dose ?? "as directed",
          frequency: m.frequency ?? "as directed",
          startedAt: new Date(),
          prescribedBy: `Document: ${doc.filename}`,
        },
      });
      applied.push(`Medication: ${m.name}`);
    }
  }

  await db.document.update({ where: { id: doc.id }, data: { extractionStatus: "CONFIRMED" } });

  audit({
    userId: guard.user.id,
    action: "portal.extraction_confirm",
    resource: `document:${doc.id}`,
    detail: applied.length > 0 ? applied.join("; ").slice(0, 500) : "no new facts (all already on file)",
  });

  return NextResponse.json({ ok: true, applied });
}
