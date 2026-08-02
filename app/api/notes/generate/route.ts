import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { generateNote } from "@/lib/ai/documentation";
import { z } from "zod";

const Body = z.object({
  patientId: z.string(),
  kind: z.enum(["soap", "consult", "discharge", "followup"]).default("soap"),
  rawInput: z.string().min(10, "Add more detail before generating."),
});

export async function POST(req: NextRequest) {
  const guard = await requireRole("DOCTOR");
  if ("error" in guard) return guard.error;

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input." },
      { status: 400 },
    );
  }
  const { patientId, kind, rawInput } = parsed.data;

  const patient = await db.patient.findUnique({
    where: { id: patientId },
    include: { conditions: true, medications: true, allergies: true },
  });
  if (!patient) return NextResponse.json({ error: "Patient not found." }, { status: 404 });

  const context = [
    `Active conditions: ${patient.conditions.filter((c) => c.status !== "RESOLVED").map((c) => c.name).join("; ") || "none"}`,
    `Active medications: ${patient.medications.filter((m) => m.status === "ACTIVE").map((m) => `${m.name} ${m.dose} ${m.frequency}`).join("; ") || "none"}`,
    `Allergies: ${patient.allergies.map((a) => a.substance).join("; ") || "none documented"}`,
  ].join("\n");

  try {
    const { note, engine } = await generateNote({ rawInput, kind, patientContext: context });
    const saved = await db.clinicalNote.create({
      data: {
        patientId,
        authorId: guard.user.id,
        kind,
        rawInput,
        ...note,
        engine,
        status: "DRAFT",
      },
    });
    audit({
      userId: guard.user.id,
      action: "ai.note_generate",
      resource: `patient:${patientId}`,
      detail: `${kind} via ${engine}`,
    });
    return NextResponse.json({ note: saved, engine });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Note generation failed." },
      { status: 500 },
    );
  }
}
