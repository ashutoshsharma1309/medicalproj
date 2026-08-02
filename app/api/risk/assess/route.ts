import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { assessRisks } from "@/lib/clinical/risk";
import { z } from "zod";

const Body = z.object({ patientId: z.string() });

export async function POST(req: NextRequest) {
  const guard = await requireRole("DOCTOR", "ADMIN");
  if ("error" in guard) return guard.error;

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "patientId is required." }, { status: 400 });

  const patient = await db.patient.findUnique({
    where: { id: parsed.data.patientId },
    include: {
      conditions: true,
      medications: true,
      allergies: true,
      labReports: { include: { values: true } },
    },
  });
  if (!patient) return NextResponse.json({ error: "Patient not found." }, { status: 404 });

  const results = await assessRisks(patient);

  // persist latest assessment per domain
  for (const r of results) {
    await db.riskAssessment.create({
      data: {
        patientId: patient.id,
        domain: r.domain,
        score: r.score,
        band: r.band,
        factors: r.factors as object[],
        narrative: r.narrative,
        engine: r.engine,
      },
    });
  }

  audit({
    userId: guard.user.id,
    action: "ai.risk_assess",
    resource: `patient:${patient.id}`,
    detail: results.map((r) => `${r.domain}=${r.score}`).join(", "),
  });

  return NextResponse.json({ results });
}
