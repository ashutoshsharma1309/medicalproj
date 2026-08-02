import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { scoreTriage } from "@/lib/clinical/triage";
import { ageOf } from "@/lib/format";
import { z } from "zod";
import type { Severity } from "@prisma/client";

const Body = z.object({
  patientId: z.string(),
  chiefComplaint: z.string().min(3),
  symptoms: z.array(z.string()).default([]),
  vitals: z.object({
    hr: z.number(),
    sbp: z.number(),
    dbp: z.number(),
    rr: z.number(),
    spo2: z.number(),
    tempC: z.number(),
    gcs: z.number().optional(),
  }),
});

export async function POST(req: NextRequest) {
  const guard = await requireRole("DOCTOR", "ADMIN");
  if ("error" in guard) return guard.error;

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid triage input." },
      { status: 400 },
    );
  }
  const { patientId, chiefComplaint, symptoms, vitals } = parsed.data;

  const patient = await db.patient.findUnique({
    where: { id: patientId },
    include: { conditions: true },
  });
  if (!patient) return NextResponse.json({ error: "Patient not found." }, { status: 404 });

  const result = scoreTriage({
    ageYears: ageOf(patient.dateOfBirth),
    chiefComplaint,
    symptoms,
    vitals,
    history: patient.conditions.map((c) => c.name),
  });

  const triageCase = await db.triageCase.create({
    data: {
      patientId,
      chiefComplaint,
      symptoms,
      vitals,
      acuity: result.acuity,
      priority: result.priority as Severity,
      score: result.score,
      rationale: result.rationale as object[],
    },
  });

  audit({
    userId: guard.user.id,
    action: "triage.create",
    resource: `patient:${patientId}`,
    detail: `acuity ${result.acuity}, score ${result.score}`,
  });

  return NextResponse.json({ case: triageCase, result });
}
