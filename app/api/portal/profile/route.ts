import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { requirePatient, generateMrn } from "@/lib/patient";
import { z } from "zod";

const BLOOD_GROUPS = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-", "Unknown"] as const;

const Body = z.object({
  fullName: z.string().trim().min(2, "Enter your full name.").max(120),
  dateOfBirth: z
    .string()
    .refine((s) => {
      const d = new Date(s);
      return !isNaN(d.getTime()) && d < new Date() && d > new Date("1900-01-01");
    }, "Enter a valid date of birth."),
  gender: z.enum(["Female", "Male", "Other"], { message: "Select a gender." }),
  phone: z.string().trim().min(7, "Enter a valid phone number.").max(24),
  bloodGroup: z.enum(BLOOD_GROUPS, { message: "Select a blood group." }),
  emergencyContactName: z.string().trim().max(120).optional().default(""),
  emergencyContactPhone: z.string().trim().max(24).optional().default(""),
  surgeries: z.string().trim().max(2000).optional().default(""),
  diseases: z.array(z.string().trim().min(1).max(120)).max(40).default([]),
  allergies: z.array(z.string().trim().min(1).max(120)).max(40).default([]),
  medications: z.array(z.string().trim().min(1).max(160)).max(60).default([]),
});

export async function GET() {
  const guard = await requirePatient();
  if ("error" in guard) return guard.error;
  if (!guard.patient) return NextResponse.json({ profile: null });

  const full = await db.patient.findUnique({
    where: { id: guard.patient.id },
    include: {
      conditions: { where: { status: { not: "RESOLVED" } } },
      allergies: true,
      medications: { where: { status: "ACTIVE" } },
    },
  });
  return NextResponse.json({ profile: full });
}

export async function PUT(req: NextRequest) {
  const guard = await requirePatient();
  if ("error" in guard) return guard.error;

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Check the form and try again." },
      { status: 400 },
    );
  }
  const d = parsed.data;
  const nameParts = d.fullName.split(/\s+/);
  const lastName = nameParts.length > 1 ? nameParts.pop()! : "";
  const firstName = nameParts.join(" ") || d.fullName;

  const scalar = {
    firstName,
    lastName: lastName || firstName,
    dateOfBirth: new Date(d.dateOfBirth),
    sex: d.gender,
    phone: d.phone,
    bloodType: d.bloodGroup === "Unknown" ? null : d.bloodGroup,
    emergencyContactName: d.emergencyContactName || null,
    emergencyContactPhone: d.emergencyContactPhone || null,
    surgeries: d.surgeries || null,
    profileCompleted: true,
  };

  let patientId: string;
  if (guard.patient) {
    await db.patient.update({ where: { id: guard.patient.id }, data: scalar });
    patientId = guard.patient.id;
  } else {
    const created = await db.patient.create({
      data: { ...scalar, mrn: await generateMrn(), userId: guard.user.id },
    });
    patientId = created.id;
  }

  // Additive merge for medical lists: patient input never deletes
  // clinician-entered data — it only adds what is not already on file.
  const existing = await db.patient.findUnique({
    where: { id: patientId },
    include: { conditions: true, allergies: true, medications: true },
  });
  const has = (list: { name?: string; substance?: string }[], value: string) =>
    list.some((x) => (x.name ?? x.substance ?? "").toLowerCase() === value.toLowerCase());

  for (const disease of d.diseases) {
    if (!has(existing!.conditions, disease)) {
      await db.condition.create({
        data: { patientId, name: disease, status: "ACTIVE", diagnosedAt: new Date(), notes: "Patient-reported during onboarding." },
      });
    }
  }
  for (const allergy of d.allergies) {
    if (!has(existing!.allergies, allergy)) {
      await db.allergy.create({
        data: { patientId, substance: allergy, reaction: "Patient-reported", severity: "MEDIUM" },
      });
    }
  }
  for (const med of d.medications) {
    // allow "Metformin 500 mg twice daily" style entries
    const m = med.match(/^([A-Za-z][A-Za-z\-\/ ]{1,60}?)(?:\s+(\d.*))?$/);
    const name = (m?.[1] ?? med).trim();
    if (!has(existing!.medications, name)) {
      await db.medication.create({
        data: {
          patientId,
          name,
          genericName: name.toLowerCase(),
          dose: m?.[2]?.trim() || "as directed",
          frequency: "as directed",
          startedAt: new Date(),
          prescribedBy: "Patient-reported",
        },
      });
    }
  }

  audit({
    userId: guard.user.id,
    action: guard.patient ? "portal.profile_update" : "portal.profile_create",
    resource: `patient:${patientId}`,
  });

  return NextResponse.json({ ok: true, redirect: "/portal" });
}
