/**
 * Seed: realistic demo cohort for Meridian.
 * Run with: npm run db:seed
 */
import { PrismaClient, Severity } from "@prisma/client";
import bcrypt from "bcryptjs";
import { scoreTriage } from "../lib/clinical/triage";

const db = new PrismaClient();

const PW = "demo1234";

async function main() {
  console.log("Clearing existing data…");
  await db.$transaction([
    db.auditLog.deleteMany(),
    db.clinicalNote.deleteMany(),
    db.triageCase.deleteMany(),
    db.riskAssessment.deleteMany(),
    db.document.deleteMany(),
    db.labValue.deleteMany(),
    db.labReport.deleteMany(),
    db.timelineEvent.deleteMany(),
    db.medication.deleteMany(),
    db.allergy.deleteMany(),
    db.condition.deleteMany(),
    db.patient.deleteMany(),
    db.user.deleteMany(),
    db.guidelineChunk.deleteMany(),
    db.drugInteraction.deleteMany(),
  ]);

  const hash = await bcrypt.hash(PW, 10);

  console.log("Creating users…");
  const drReyes = await db.user.create({
    data: {
      email: "dr.reyes@meridian.health",
      passwordHash: hash,
      name: "Dr. Alana Reyes",
      role: "DOCTOR",
      title: "Attending Physician, Internal Medicine",
    },
  });
  await db.user.create({
    data: {
      email: "dr.osei@meridian.health",
      passwordHash: hash,
      name: "Dr. Kwame Osei",
      role: "DOCTOR",
      title: "Emergency Medicine",
    },
  });
  await db.user.create({
    data: {
      email: "admin@meridian.health",
      passwordHash: hash,
      name: "Sam Whitfield",
      role: "ADMIN",
      title: "Clinical Systems Administrator",
    },
  });
  const patientUser = await db.user.create({
    data: {
      email: "eleanor.vance@example.com",
      passwordHash: hash,
      name: "Eleanor Vance",
      role: "PATIENT",
    },
  });

  const y = (yearsAgo: number, month = 5, day = 12) => {
    const d = new Date();
    d.setFullYear(d.getFullYear() - yearsAgo);
    d.setMonth(month, day);
    return d;
  };
  const daysAgo = (n: number, h = 9) => {
    const d = new Date(Date.now() - n * 86400000);
    d.setHours(h, 15, 0, 0);
    return d;
  };

  console.log("Creating patients…");

  /* ---------------- Patient 1: Eleanor Vance — the demo centerpiece ------ */
  const eleanor = await db.patient.create({
    data: {
      mrn: "MRN-004821",
      firstName: "Eleanor",
      lastName: "Vance",
      dateOfBirth: new Date("1958-03-14"),
      sex: "Female",
      bloodType: "A+",
      phone: "(555) 014-2231",
      heightCm: 162,
      weightKg: 84,
      smoker: false,
      profileCompleted: true,
      emergencyContactName: "Martin Vance (son)",
      emergencyContactPhone: "(555) 014-9987",
      userId: patientUser.id,
      conditions: {
        create: [
          { name: "Type 2 Diabetes Mellitus", icd10: "E11.9", status: "ACTIVE", diagnosedAt: y(7, 2, 18), notes: "Diagnosed after routine screening; initially diet-controlled." },
          { name: "Essential Hypertension", icd10: "I10", status: "ACTIVE", diagnosedAt: y(6, 8, 4) },
          { name: "Hyperlipidemia", icd10: "E78.5", status: "MANAGED", diagnosedAt: y(5, 1, 22) },
        ],
      },
      allergies: {
        create: [
          { substance: "Penicillin", reaction: "Urticaria and facial swelling (2009)", severity: "HIGH" },
          { substance: "Latex", reaction: "Contact dermatitis", severity: "LOW" },
        ],
      },
      medications: {
        create: [
          { name: "Metformin", genericName: "metformin", dose: "1000 mg", frequency: "twice daily", startedAt: y(7, 3, 1), prescribedBy: "Dr. Alana Reyes" },
          { name: "Lisinopril", genericName: "lisinopril", dose: "20 mg", frequency: "once daily", startedAt: y(6, 9, 10), prescribedBy: "Dr. Alana Reyes" },
          { name: "Atorvastatin", genericName: "atorvastatin", dose: "40 mg", frequency: "at night", startedAt: y(5, 2, 5), prescribedBy: "Dr. Alana Reyes" },
          // Deliberate safety-demo entry: conflicts with penicillin allergy
          { name: "Amoxicillin", genericName: "amoxicillin", dose: "500 mg", frequency: "three times daily × 7 days", startedAt: daysAgo(1), prescribedBy: "Urgent Care (external)" },
          { name: "Glipizide", genericName: "glipizide", dose: "5 mg", frequency: "once daily", status: "DISCONTINUED", startedAt: y(4, 1, 9), stoppedAt: y(2, 6, 20), prescribedBy: "Dr. Alana Reyes" },
        ],
      },
    },
  });

  await db.timelineEvent.createMany({
    data: [
      { patientId: eleanor.id, occurredAt: y(7, 2, 18), category: "diagnosis", title: "Type 2 diabetes diagnosed", detail: "HbA1c 7.1% on screening; started on lifestyle modification.", severity: "MEDIUM" },
      { patientId: eleanor.id, occurredAt: y(7, 3, 1), category: "medication", title: "Metformin started", detail: "500 mg twice daily, titrated to 1000 mg over 8 weeks.", severity: "LOW" },
      { patientId: eleanor.id, occurredAt: y(6, 8, 4), category: "diagnosis", title: "Hypertension diagnosed", detail: "Repeated office readings ≥ 150/95.", severity: "MEDIUM" },
      { patientId: eleanor.id, occurredAt: y(6, 9, 10), category: "medication", title: "Lisinopril started", detail: "10 mg daily, increased to 20 mg after 3 months.", severity: "LOW" },
      { patientId: eleanor.id, occurredAt: y(5, 2, 5), category: "medication", title: "Atorvastatin started", detail: "LDL 168 mg/dL on annual panel.", severity: "LOW" },
      { patientId: eleanor.id, occurredAt: y(4, 1, 9), category: "medication", title: "Glipizide added", detail: "HbA1c drifting upward despite metformin.", severity: "LOW" },
      { patientId: eleanor.id, occurredAt: y(2, 6, 20), category: "medication", title: "Glipizide discontinued", detail: "Two hypoglycemic episodes; discontinued in favor of lifestyle re-engagement.", severity: "MEDIUM" },
      { patientId: eleanor.id, occurredAt: y(1, 10, 2), category: "lab", title: "HbA1c rising (7.4%)", detail: "Above individualized target of 7.0%.", severity: "MEDIUM" },
      { patientId: eleanor.id, occurredAt: daysAgo(6), category: "lab", title: "HbA1c 8.5% — control deteriorating", detail: "Second consecutive rise; therapy intensification indicated.", severity: "HIGH" },
      { patientId: eleanor.id, occurredAt: daysAgo(1), category: "medication", title: "Amoxicillin prescribed externally", detail: "Prescribed at urgent care for sinusitis — allergy conflict flagged by Meridian.", severity: "CRITICAL" },
    ],
  });

  const eleanorLabs = [
    { yearsAgo: 3, hba1c: 6.8, glucose: 128, ldl: 118, creatinine: 0.9 },
    { yearsAgo: 2, hba1c: 7.1, glucose: 142, ldl: 104, creatinine: 1.0 },
    { yearsAgo: 1, hba1c: 7.4, glucose: 155, ldl: 96, creatinine: 1.0 },
  ];
  for (const l of eleanorLabs) {
    await db.labReport.create({
      data: {
        patientId: eleanor.id,
        title: "Comprehensive Metabolic + HbA1c Panel",
        category: "endocrine",
        collectedAt: y(l.yearsAgo, 9, 15),
        reviewedBy: "Dr. Alana Reyes",
        values: {
          create: [
            { analyte: "HbA1c", value: l.hba1c, unit: "%", refLow: 4.0, refHigh: 5.6, flag: l.hba1c > 5.6 ? "H" : null },
            { analyte: "Glucose", value: l.glucose, unit: "mg/dL", refLow: 70, refHigh: 99, flag: l.glucose > 99 ? "H" : null },
            { analyte: "LDL", value: l.ldl, unit: "mg/dL", refLow: 0, refHigh: 100, flag: l.ldl > 100 ? "H" : null },
            { analyte: "Creatinine", value: l.creatinine, unit: "mg/dL", refLow: 0.7, refHigh: 1.3, flag: null },
          ],
        },
      },
    });
  }
  await db.labReport.create({
    data: {
      patientId: eleanor.id,
      title: "HbA1c + Renal Function Panel",
      category: "endocrine",
      collectedAt: daysAgo(6),
      reviewedBy: "Dr. Alana Reyes",
      summary:
        "HbA1c has risen from 7.4% to 8.5% over twelve months — the second consecutive increase and now well above the 7.0% target. Renal function remains preserved (eGFR 88). Trend indicates therapy intensification is due.",
      values: {
        create: [
          { analyte: "HbA1c", value: 8.5, unit: "%", refLow: 4.0, refHigh: 5.6, flag: "H" },
          { analyte: "Glucose", value: 182, unit: "mg/dL", refLow: 70, refHigh: 99, flag: "H" },
          { analyte: "LDL", value: 92, unit: "mg/dL", refLow: 0, refHigh: 100, flag: null },
          { analyte: "Creatinine", value: 1.0, unit: "mg/dL", refLow: 0.7, refHigh: 1.3, flag: null },
          { analyte: "eGFR", value: 88, unit: "mL/min", refLow: 90, refHigh: 120, flag: "L" },
          { analyte: "Potassium", value: 4.4, unit: "mmol/L", refLow: 3.5, refHigh: 5.1, flag: null },
        ],
      },
    },
  });

  await db.document.create({
    data: {
      patientId: eleanor.id,
      filename: "urgent-care-visit-summary.txt",
      kind: "discharge_summary",
      rawText: `URGENT CARE VISIT SUMMARY
Patient: Eleanor Vance   DOB: 03/14/1958
Date of visit: ${daysAgo(1).toDateString()}

Chief complaint: facial pressure, purulent nasal discharge x 9 days, low-grade fever.
Assessment: acute bacterial sinusitis.
Allergies: Penicillin (rash, swelling)

Medications prescribed:
- Amoxicillin 500 mg three times daily for 7 days
- Fluticasone nasal spray twice daily

Follow up with primary care physician if symptoms persist beyond 7 days.`,
      extraction: {
        patientName: "Eleanor Vance",
        documentType: "discharge_summary",
        conditions: ["Acute bacterial sinusitis"],
        symptoms: ["Facial pressure", "Purulent nasal discharge", "Low-grade fever"],
        allergies: ["Penicillin"],
        medications: [
          { name: "Amoxicillin", dose: "500 mg", frequency: "three times daily × 7 days" },
          { name: "Fluticasone", dose: "nasal spray", frequency: "twice daily" },
        ],
        labValues: [],
        riskFactors: ["Penicillin allergy with beta-lactam prescription"],
        keyFindings: ["Amoxicillin prescribed despite documented penicillin allergy — cross-reactivity risk"],
        summary:
          "External urgent-care visit for bacterial sinusitis. Amoxicillin was prescribed despite the documented penicillin allergy — this beta-lactam cross-reactivity conflict requires prescriber attention before the course begins.",
      },
      extractedWith: "deterministic-parser-v1",
      uploadedAt: daysAgo(1, 14),
    },
  });

  /* ---------------- Patient 2: Marcus Webb — cardiac ---------------------- */
  const marcus = await db.patient.create({
    data: {
      mrn: "MRN-007311",
      profileCompleted: true,
      firstName: "Marcus",
      lastName: "Webb",
      dateOfBirth: new Date("1971-11-02"),
      sex: "Male",
      bloodType: "O-",
      phone: "(555) 019-8842",
      heightCm: 180,
      weightKg: 96,
      smoker: false,
      conditions: {
        create: [
          { name: "Coronary Artery Disease", icd10: "I25.10", status: "ACTIVE", diagnosedAt: y(4, 4, 2), notes: "NSTEMI with two drug-eluting stents to the LAD." },
          { name: "Heart Failure (reduced EF)", icd10: "I50.22", status: "ACTIVE", diagnosedAt: y(2, 0, 15), notes: "EF 38% on last echocardiogram." },
          { name: "Atrial Fibrillation", icd10: "I48.91", status: "ACTIVE", diagnosedAt: y(1, 7, 8) },
        ],
      },
      allergies: { create: [{ substance: "Sulfa", reaction: "Widespread rash", severity: "MEDIUM" }] },
      medications: {
        create: [
          { name: "Warfarin", genericName: "warfarin", dose: "5 mg", frequency: "once daily", startedAt: y(1, 7, 12), prescribedBy: "Dr. Chen (Cardiology)" },
          { name: "Aspirin", genericName: "aspirin", dose: "81 mg", frequency: "once daily", startedAt: y(4, 4, 6), prescribedBy: "Dr. Chen (Cardiology)" },
          { name: "Metoprolol", genericName: "metoprolol", dose: "50 mg", frequency: "twice daily", startedAt: y(4, 4, 6) },
          { name: "Sacubitril/Valsartan", genericName: "sacubitril-valsartan", dose: "49/51 mg", frequency: "twice daily", startedAt: y(2, 1, 3) },
          { name: "Atorvastatin", genericName: "atorvastatin", dose: "80 mg", frequency: "at night", startedAt: y(4, 4, 6) },
        ],
      },
    },
  });
  await db.timelineEvent.createMany({
    data: [
      { patientId: marcus.id, occurredAt: y(4, 4, 2), category: "admission", title: "NSTEMI — PCI with 2 stents", detail: "Presented with crushing chest pain; troponin peak 2.1. LAD stented.", severity: "CRITICAL" },
      { patientId: marcus.id, occurredAt: y(2, 0, 15), category: "diagnosis", title: "Heart failure with reduced EF", detail: "Progressive exertional dyspnea; echo EF 38%.", severity: "HIGH" },
      { patientId: marcus.id, occurredAt: y(2, 1, 3), category: "medication", title: "Started sacubitril/valsartan", detail: "Transitioned from lisinopril per HFrEF guideline.", severity: "LOW" },
      { patientId: marcus.id, occurredAt: y(1, 7, 8), category: "diagnosis", title: "Atrial fibrillation detected", detail: "Palpitations; ECG confirmed AF. CHA₂DS₂-VASc 4.", severity: "HIGH" },
      { patientId: marcus.id, occurredAt: y(1, 7, 12), category: "medication", title: "Warfarin initiated", detail: "Anticoagulation for stroke prevention — aspirin continued (flagged).", severity: "MEDIUM" },
      { patientId: marcus.id, occurredAt: daysAgo(12), category: "lab", title: "BNP elevated (412 pg/mL)", detail: "Up from 260; volume status review scheduled.", severity: "HIGH" },
    ],
  });
  await db.labReport.create({
    data: {
      patientId: marcus.id,
      title: "Cardiac Panel",
      category: "cardiac",
      collectedAt: daysAgo(12),
      reviewedBy: "Dr. Alana Reyes",
      values: {
        create: [
          { analyte: "BNP", value: 412, unit: "pg/mL", refLow: 0, refHigh: 100, flag: "H" },
          { analyte: "Troponin", value: 0.02, unit: "ng/mL", refLow: 0, refHigh: 0.04, flag: null },
          { analyte: "Potassium", value: 4.9, unit: "mmol/L", refLow: 3.5, refHigh: 5.1, flag: null },
          { analyte: "Creatinine", value: 1.4, unit: "mg/dL", refLow: 0.7, refHigh: 1.3, flag: "H" },
          { analyte: "LDL", value: 68, unit: "mg/dL", refLow: 0, refHigh: 100, flag: null },
        ],
      },
    },
  });

  /* ---------------- Patient 3: Priya Raman — low-risk contrast ----------- */
  const priya = await db.patient.create({
    data: {
      mrn: "MRN-009654",
      profileCompleted: true,
      firstName: "Priya",
      lastName: "Raman",
      dateOfBirth: new Date("1984-06-27"),
      sex: "Female",
      bloodType: "B+",
      heightCm: 165,
      weightKg: 61,
      smoker: false,
      conditions: {
        create: [{ name: "Mild Persistent Asthma", icd10: "J45.30", status: "MANAGED", diagnosedAt: y(12, 3, 3), notes: "Well controlled on low-dose ICS." }],
      },
      allergies: { create: [] },
      medications: {
        create: [
          { name: "Fluticasone/Salmeterol", genericName: "fluticasone-salmeterol", dose: "100/50 mcg", frequency: "twice daily inhaled", startedAt: y(3, 2, 10) },
          { name: "Albuterol", genericName: "albuterol", dose: "90 mcg", frequency: "as needed", startedAt: y(12, 3, 3) },
        ],
      },
    },
  });
  await db.timelineEvent.createMany({
    data: [
      { patientId: priya.id, occurredAt: y(12, 3, 3), category: "diagnosis", title: "Asthma diagnosed", severity: "MEDIUM", detail: "Exercise-induced wheeze; spirometry confirmed reversible obstruction." },
      { patientId: priya.id, occurredAt: y(3, 2, 10), category: "medication", title: "Stepped up to combination inhaler", severity: "LOW", detail: "Night symptoms twice weekly on ICS alone." },
      { patientId: priya.id, occurredAt: y(0, 1, 20), category: "note", title: "Annual review — well controlled", severity: "LOW", detail: "ACT score 24/25. No exacerbations in 18 months." },
    ],
  });

  /* ---------------- Patient 4: David Okafor — CKD + diabetes -------------- */
  const david = await db.patient.create({
    data: {
      mrn: "MRN-002198",
      profileCompleted: true,
      firstName: "David",
      lastName: "Okafor",
      dateOfBirth: new Date("1953-09-19"),
      sex: "Male",
      bloodType: "AB+",
      heightCm: 175,
      weightKg: 88,
      smoker: false,
      conditions: {
        create: [
          { name: "Type 2 Diabetes Mellitus", icd10: "E11.22", status: "ACTIVE", diagnosedAt: y(15, 5, 5) },
          { name: "Chronic Kidney Disease Stage 3b", icd10: "N18.32", status: "ACTIVE", diagnosedAt: y(3, 10, 12) },
          { name: "Essential Hypertension", icd10: "I10", status: "ACTIVE", diagnosedAt: y(14, 2, 2) },
        ],
      },
      allergies: { create: [{ substance: "Codeine", reaction: "Severe nausea", severity: "MEDIUM" }] },
      medications: {
        create: [
          { name: "Insulin Glargine", genericName: "insulin glargine", dose: "24 units", frequency: "at night", route: "subcutaneous", startedAt: y(5, 1, 8) },
          { name: "Amlodipine", genericName: "amlodipine", dose: "10 mg", frequency: "once daily", startedAt: y(8, 4, 4) },
          { name: "Losartan", genericName: "losartan", dose: "100 mg", frequency: "once daily", startedAt: y(6, 6, 6) },
        ],
      },
    },
  });
  await db.timelineEvent.createMany({
    data: [
      { patientId: david.id, occurredAt: y(15, 5, 5), category: "diagnosis", title: "Type 2 diabetes diagnosed", severity: "MEDIUM" },
      { patientId: david.id, occurredAt: y(5, 1, 8), category: "medication", title: "Transitioned to basal insulin", detail: "Oral agents insufficient; HbA1c 9.2%.", severity: "MEDIUM" },
      { patientId: david.id, occurredAt: y(3, 10, 12), category: "diagnosis", title: "CKD stage 3b", detail: "eGFR persistently 30–44; nephrology referral placed.", severity: "HIGH" },
      { patientId: david.id, occurredAt: daysAgo(30), category: "lab", title: "eGFR 38 — stable but reduced", severity: "MEDIUM" },
    ],
  });
  await db.labReport.create({
    data: {
      patientId: david.id,
      title: "Renal Function + HbA1c",
      category: "chemistry",
      collectedAt: daysAgo(30),
      reviewedBy: "Dr. Alana Reyes",
      values: {
        create: [
          { analyte: "eGFR", value: 38, unit: "mL/min", refLow: 90, refHigh: 120, flag: "L" },
          { analyte: "Creatinine", value: 1.9, unit: "mg/dL", refLow: 0.7, refHigh: 1.3, flag: "H" },
          { analyte: "HbA1c", value: 7.8, unit: "%", refLow: 4.0, refHigh: 5.6, flag: "H" },
          { analyte: "Potassium", value: 5.0, unit: "mmol/L", refLow: 3.5, refHigh: 5.1, flag: null },
          { analyte: "Hemoglobin", value: 11.2, unit: "g/dL", refLow: 12.0, refHigh: 17.5, flag: "L" },
        ],
      },
    },
  });

  /* ---------------- Patient 5: Robert Chen — smoker, high CV risk --------- */
  const robert = await db.patient.create({
    data: {
      mrn: "MRN-005570",
      profileCompleted: true,
      firstName: "Robert",
      lastName: "Chen",
      dateOfBirth: new Date("1967-01-30"),
      sex: "Male",
      bloodType: "A-",
      heightCm: 172,
      weightKg: 91,
      smoker: true,
      conditions: {
        create: [
          { name: "Hyperlipidemia", icd10: "E78.5", status: "ACTIVE", diagnosedAt: y(2, 3, 14) },
          { name: "Essential Hypertension", icd10: "I10", status: "ACTIVE", diagnosedAt: y(2, 3, 14) },
        ],
      },
      allergies: { create: [] },
      medications: {
        create: [
          { name: "Rosuvastatin", genericName: "rosuvastatin", dose: "20 mg", frequency: "once daily", startedAt: y(2, 4, 1) },
          { name: "Lisinopril", genericName: "lisinopril", dose: "10 mg", frequency: "once daily", startedAt: y(2, 4, 1) },
        ],
      },
    },
  });
  await db.timelineEvent.createMany({
    data: [
      { patientId: robert.id, occurredAt: y(2, 3, 14), category: "diagnosis", title: "Hypertension and hyperlipidemia diagnosed", detail: "Found on employment physical. LDL 176, BP 156/98.", severity: "MEDIUM" },
      { patientId: robert.id, occurredAt: daysAgo(45), category: "note", title: "Smoking cessation counselling", detail: "20 pack-year history. Declined pharmacotherapy; will consider patches.", severity: "MEDIUM" },
    ],
  });
  await db.labReport.create({
    data: {
      patientId: robert.id,
      title: "Lipid Panel",
      category: "lipid",
      collectedAt: daysAgo(45),
      reviewedBy: "Dr. Alana Reyes",
      values: {
        create: [
          { analyte: "LDL", value: 148, unit: "mg/dL", refLow: 0, refHigh: 100, flag: "H" },
          { analyte: "HDL", value: 38, unit: "mg/dL", refLow: 40, refHigh: 90, flag: "L" },
          { analyte: "Triglycerides", value: 210, unit: "mg/dL", refLow: 0, refHigh: 150, flag: "H" },
          { analyte: "Total Cholesterol", value: 228, unit: "mg/dL", refLow: 0, refHigh: 200, flag: "H" },
        ],
      },
    },
  });

  /* ---------------- Clinical notes ---------------------------------------- */
  await db.clinicalNote.create({
    data: {
      patientId: eleanor.id,
      authorId: drReyes.id,
      kind: "soap",
      status: "FINALIZED",
      rawInput:
        "F/u diabetes. Reports more thirst, nocturia x2. Diet adherence slipped since spring. BP 142/88, HR 76. HbA1c back at 8.5 from 7.4. Feet intact, monofilament normal. Plan: discuss adding SGLT2i, re-refer dietitian, repeat A1c 3 months, home BP log.",
      subjective:
        "Follow-up for type 2 diabetes. Reports increased thirst and nocturia twice nightly. Acknowledges reduced dietary adherence over recent months.",
      objective:
        "BP 142/88 mmHg, HR 76 bpm. Foot exam: skin intact, monofilament sensation normal bilaterally. HbA1c 8.5% (prior 7.4%).",
      assessment:
        "Type 2 diabetes with deteriorating glycemic control — second consecutive HbA1c rise, now 1.5% above target. Hypertension borderline at today's reading.",
      plan:
        "Discussed adding an SGLT2 inhibitor; patient will consider. Dietitian re-referral placed. Repeat HbA1c in 3 months. Home blood-pressure log for 2 weeks before next visit.",
      summary:
        "Your blood sugar control has drifted upward, so we discussed adding a second diabetes medicine and meeting the dietitian again. Please check your blood pressure at home and we will repeat blood tests in three months.",
      followUp: "Repeat HbA1c in 3 months; review home BP log at next visit (4 weeks).",
      engine: "physician-authored",
      createdAt: daysAgo(6, 15),
    },
  });

  /* ---------------- Triage queue ------------------------------------------ */
  console.log("Creating triage queue…");
  const triageSeed = [
    {
      patient: marcus,
      arrivedMinsAgo: 18,
      chiefComplaint: "Crushing central chest pain radiating to left arm",
      symptoms: ["chest pain", "shortness of breath"],
      vitals: { hr: 118, sbp: 92, dbp: 60, rr: 24, spo2: 93, tempC: 36.9 },
      history: ["Coronary Artery Disease", "Heart Failure", "Atrial Fibrillation"],
      status: "WAITING" as const,
    },
    {
      patient: eleanor,
      arrivedMinsAgo: 42,
      chiefComplaint: "Dizziness and confusion since this morning",
      symptoms: ["dizziness", "altered mental status"],
      vitals: { hr: 104, sbp: 108, dbp: 70, rr: 20, spo2: 96, tempC: 37.2, gcs: 14 },
      history: ["Type 2 Diabetes", "Hypertension"],
      status: "WAITING" as const,
    },
    {
      patient: david,
      arrivedMinsAgo: 65,
      chiefComplaint: "Swollen legs and reduced urine output over 3 days",
      symptoms: ["edema", "fatigue"],
      vitals: { hr: 88, sbp: 165, dbp: 95, rr: 18, spo2: 95, tempC: 36.8 },
      history: ["Chronic Kidney Disease", "Diabetes", "Hypertension"],
      status: "WAITING" as const,
    },
    {
      patient: priya,
      arrivedMinsAgo: 25,
      chiefComplaint: "Wheezing after cleaning with strong chemicals",
      symptoms: ["shortness of breath", "cough"],
      vitals: { hr: 98, sbp: 124, dbp: 78, rr: 22, spo2: 95, tempC: 36.7 },
      history: ["Asthma"],
      status: "WAITING" as const,
    },
    {
      patient: robert,
      arrivedMinsAgo: 95,
      chiefComplaint: "Sprained ankle playing basketball",
      symptoms: ["ankle pain"],
      vitals: { hr: 78, sbp: 138, dbp: 86, rr: 14, spo2: 99, tempC: 36.6 },
      history: ["Hypertension", "Hyperlipidemia"],
      status: "WAITING" as const,
    },
  ];

  for (const t of triageSeed) {
    const ageYears = Math.floor((Date.now() - t.patient.dateOfBirth.getTime()) / 31557600000);
    const result = scoreTriage({
      ageYears,
      chiefComplaint: t.chiefComplaint,
      symptoms: t.symptoms,
      vitals: t.vitals,
      history: t.history,
    });
    await db.triageCase.create({
      data: {
        patientId: t.patient.id,
        arrivedAt: new Date(Date.now() - t.arrivedMinsAgo * 60000),
        chiefComplaint: t.chiefComplaint,
        symptoms: t.symptoms,
        vitals: t.vitals,
        acuity: result.acuity,
        priority: result.priority as Severity,
        score: result.score,
        rationale: result.rationale as object[],
        status: t.status,
      },
    });
  }

  /* ---------------- Drug interaction knowledge ---------------------------- */
  console.log("Seeding drug interactions…");
  await db.drugInteraction.createMany({
    data: [
      { drugA: "warfarin", drugB: "aspirin", severity: "HIGH", mechanism: "Additive antiplatelet and anticoagulant effect substantially raises major bleeding risk.", advice: "Verify dual therapy is intentional (e.g. recent stent); otherwise consider stopping aspirin per current AF guidance. Monitor INR closely and counsel on bleeding signs." },
      { drugA: "warfarin", drugB: "ibuprofen", severity: "HIGH", mechanism: "NSAIDs impair platelet function and injure gastric mucosa while warfarin prevents clotting.", advice: "Avoid combination; use acetaminophen for analgesia where possible." },
      { drugA: "warfarin", drugB: "amoxicillin", severity: "MEDIUM", mechanism: "Antibiotics disrupt gut flora that synthesize vitamin K, potentiating warfarin.", advice: "Check INR within 3–5 days of starting the antibiotic." },
      { drugA: "lisinopril", drugB: "spironolactone", severity: "HIGH", mechanism: "Dual potassium-retaining agents; risk of severe hyperkalemia.", advice: "Monitor potassium within 1 week of initiation and after dose changes." },
      { drugA: "lisinopril", drugB: "losartan", severity: "HIGH", mechanism: "Dual renin-angiotensin blockade increases hyperkalemia, hypotension and renal-failure risk without outcome benefit.", advice: "Avoid combination; choose a single RAS agent." },
      { drugA: "simvastatin", drugB: "clarithromycin", severity: "CRITICAL", mechanism: "CYP3A4 inhibition raises statin levels up to 10-fold — rhabdomyolysis risk.", advice: "Suspend the statin during the macrolide course or use azithromycin." },
      { drugA: "sertraline", drugB: "tramadol", severity: "HIGH", mechanism: "Both increase serotonergic tone — serotonin syndrome risk; tramadol also lowers seizure threshold.", advice: "Prefer non-serotonergic analgesia; if unavoidable, counsel on serotonin-syndrome symptoms." },
      { drugA: "digoxin", drugB: "amiodarone", severity: "HIGH", mechanism: "Amiodarone reduces digoxin clearance, roughly doubling serum levels.", advice: "Halve the digoxin dose on initiation and monitor levels." },
      { drugA: "metformin", drugB: "iodinated contrast", severity: "MEDIUM", mechanism: "Contrast-induced renal impairment can precipitate metformin-associated lactic acidosis.", advice: "Hold metformin at the time of contrast imaging and for 48 h after when eGFR < 60; recheck renal function before restarting." },
      { drugA: "metoprolol", drugB: "verapamil", severity: "HIGH", mechanism: "Additive AV-nodal blockade — bradycardia and heart-block risk.", advice: "Avoid combination in conduction disease; monitor heart rate and PR interval if required." },
      { drugA: "atorvastatin", drugB: "gemfibrozil", severity: "HIGH", mechanism: "Gemfibrozil inhibits statin glucuronidation — myopathy risk.", advice: "Prefer fenofibrate if combination lipid therapy is required." },
      { drugA: "insulin glargine", drugB: "glipizide", severity: "MEDIUM", mechanism: "Additive hypoglycemia risk when basal insulin is combined with a sulfonylurea.", advice: "Reassess sulfonylurea need at insulin initiation; reinforce hypoglycemia recognition." },
    ],
  });

  /* ---------------- Guideline corpus for RAG ------------------------------ */
  console.log("Seeding guideline corpus…");
  const chunks: { source: string; section: string; content: string }[] = [
    {
      source: "Meridian Formulary Guidance — Glycemic Management in Type 2 Diabetes (2025)",
      section: "HbA1c targets and escalation",
      content:
        "For most non-pregnant adults a reasonable HbA1c target is ≤ 7.0%; less stringent targets (up to 8.0%) are appropriate for limited life expectancy, hypoglycemia history or extensive comorbidity. When HbA1c remains above the individualized target on two consecutive measurements despite adherence, therapy should be intensified rather than repeated unchanged. Metformin remains first-line unless eGFR < 30 mL/min. In patients with established atherosclerotic cardiovascular disease, heart failure or CKD, an SGLT2 inhibitor or GLP-1 receptor agonist with proven benefit should be added independent of HbA1c.",
    },
    {
      source: "Meridian Formulary Guidance — Glycemic Management in Type 2 Diabetes (2025)",
      section: "Sulfonylureas and hypoglycemia",
      content:
        "Sulfonylureas (glipizide, glimepiride, glyburide) are effective but carry the highest hypoglycemia risk among oral agents, particularly in older adults and renal impairment. Recurrent hypoglycemia on a sulfonylurea is an indication to discontinue the agent and reconsider the regimen — usually in favor of agents with intrinsic low hypoglycemia risk such as SGLT2 inhibitors, GLP-1 receptor agonists or DPP-4 inhibitors.",
    },
    {
      source: "Meridian Clinical Protocols — Hypertension (2025)",
      section: "Targets in comorbid disease",
      content:
        "For adults with hypertension and diabetes, chronic kidney disease or established cardiovascular disease, the recommended office blood-pressure target is < 130/80 mmHg, provided it is achieved without unacceptable adverse effects. Home blood-pressure monitoring should verify office readings before therapy escalation. First-line agents are ACE inhibitors or ARBs (never combined with each other), calcium-channel blockers and thiazide-like diuretics.",
    },
    {
      source: "Meridian Clinical Protocols — Hypertension (2025)",
      section: "Hypertensive crisis",
      content:
        "Blood pressure > 180/120 mmHg with evidence of acute end-organ damage (encephalopathy, chest pain, pulmonary edema, acute kidney injury, visual changes) constitutes a hypertensive emergency requiring immediate IV therapy in a monitored setting, lowering MAP by no more than 25% within the first hour. Severe elevation without end-organ damage may be managed with oral agents and close outpatient follow-up within days.",
    },
    {
      source: "Meridian Anticoagulation Handbook (2025)",
      section: "Combining anticoagulants and antiplatelets",
      content:
        "Combined oral anticoagulant and antiplatelet therapy substantially increases major bleeding without added stroke protection in most atrial fibrillation patients. Beyond one year after PCI or ACS, patients with AF should generally continue the anticoagulant alone and stop the antiplatelet. Exceptions (recent stent, high ischemic burden) should be documented explicitly with a planned stop date for the antiplatelet.",
    },
    {
      source: "Meridian Anticoagulation Handbook (2025)",
      section: "Warfarin monitoring and drug interference",
      content:
        "Warfarin requires INR monitoring at least every 4 weeks once stable, and within 3–5 days of starting or stopping interacting drugs — notably antibiotics, amiodarone, azole antifungals and NSAIDs. Target INR is 2.0–3.0 for atrial fibrillation and venous thromboembolism. Patient counselling must cover bleeding warning signs and consistent vitamin K intake.",
    },
    {
      source: "Meridian Emergency Medicine Pathways (2025)",
      section: "Chest pain triage",
      content:
        "Any adult with acute non-traumatic chest pain should receive a 12-lead ECG within 10 minutes of arrival. High-risk features mandating immediate physician review include hypotension, new heart failure signs, syncope, ongoing pain despite nitrates, dynamic ECG changes and elevated troponin. Known coronary disease, diabetes and age > 65 raise pre-test probability and should lower the threshold for continuous monitoring.",
    },
    {
      source: "Meridian Emergency Medicine Pathways (2025)",
      section: "Sepsis recognition",
      content:
        "Screen for sepsis in any patient with suspected infection plus two of: temperature > 38.3°C or < 36°C, heart rate > 90, respiratory rate > 22, altered mentation, or systolic BP < 100 mmHg. When sepsis is suspected, obtain cultures and lactate and begin broad-spectrum antimicrobials within one hour. Hypotension unresponsive to 30 mL/kg crystalloid defines septic shock and requires vasopressors targeting MAP ≥ 65 mmHg.",
    },
    {
      source: "Meridian Clinical Protocols — Chronic Kidney Disease (2025)",
      section: "Staging and referral",
      content:
        "CKD is staged by eGFR: stage 3a 45–59, 3b 30–44, stage 4 15–29, stage 5 < 15 mL/min. Refer to nephrology at stage 4, with rapidly declining function (> 5 mL/min/year), or with persistent ACR > 300 mg/g. In diabetic kidney disease, prescribe an ACE inhibitor or ARB titrated to maximum tolerated dose, and add an SGLT2 inhibitor for eGFR ≥ 20 mL/min. Avoid NSAIDs and dose-adjust renally cleared drugs from stage 3b.",
    },
    {
      source: "Meridian Clinical Protocols — Chronic Kidney Disease (2025)",
      section: "Anemia of CKD",
      content:
        "Evaluate hemoglobin < 12 g/dL (women) or < 13 g/dL (men) in CKD with iron studies before attributing anemia to erythropoietin deficiency. Replete iron when transferrin saturation < 30% and ferritin < 500 ng/mL. Erythropoiesis-stimulating agents are reserved for hemoglobin < 10 g/dL after iron repletion, targeting 10–11.5 g/dL.",
    },
    {
      source: "Meridian Respiratory Care Pathways (2025)",
      section: "Asthma exacerbation severity",
      content:
        "Classify asthma exacerbations by ability to speak, respiratory rate, accessory-muscle use, SpO₂ and peak flow. SpO₂ 90–95% with full sentences suggests moderate exacerbation: give inhaled short-acting beta-agonist (4–10 puffs via spacer every 20 minutes for the first hour) and oral corticosteroids early. SpO₂ < 90%, inability to complete sentences, or silent chest indicates severe/life-threatening exacerbation requiring continuous nebulization, IV magnesium consideration and senior review.",
    },
    {
      source: "Meridian Lipid Management Protocol (2025)",
      section: "Statin intensity and targets",
      content:
        "High-intensity statin therapy (atorvastatin 40–80 mg, rosuvastatin 20–40 mg) is indicated for established atherosclerotic disease and for LDL ≥ 190 mg/dL. For secondary prevention the LDL goal is < 70 mg/dL (< 55 in very-high-risk patients); add ezetimibe and then a PCSK9 inhibitor if the goal is not reached on maximally tolerated statin. Recheck lipids 4–12 weeks after any change.",
    },
    {
      source: "Meridian Antimicrobial Stewardship (2025)",
      section: "Beta-lactam allergy assessment",
      content:
        "A documented penicillin allergy should be characterized before prescribing: reaction type, timing and severity. True IgE-mediated reactions (urticaria, angioedema, anaphylaxis) contraindicate penicillins including aminopenicillins such as amoxicillin; cross-reactivity with cephalosporins is low (~2%) but third-generation agents or non-beta-lactams are preferred when the index reaction was severe. Unverified childhood rash labels warrant allergy referral for de-labelling, since penicillin allergy labels drive broader-spectrum antibiotic use and worse outcomes.",
    },
    {
      source: "Meridian Antimicrobial Stewardship (2025)",
      section: "Acute sinusitis",
      content:
        "Most acute rhinosinusitis is viral and resolves without antibiotics. Reserve antibiotics for symptoms ≥ 10 days without improvement, severe onset (fever ≥ 39°C with purulent discharge ≥ 3 days), or worsening after initial improvement. First-line is amoxicillin-clavulanate; in confirmed penicillin allergy use doxycycline or a respiratory fluoroquinolone. Duration 5–7 days in adults.",
    },
  ];

  for (const c of chunks) {
    await db.guidelineChunk.create({
      data: {
        ...c,
        keywords: [
          ...new Set(
            (c.section + " " + c.content)
              .toLowerCase()
              .replace(/[^a-z0-9 ]/g, " ")
              .split(/\s+/)
              .filter((w) => w.length > 3),
          ),
        ].join(" "),
      },
    });
  }

  console.log("Seed complete.");
  console.log("Demo accounts (password: demo1234):");
  console.log("  Doctor : dr.reyes@meridian.health");
  console.log("  Admin  : admin@meridian.health");
  console.log("  Patient: eleanor.vance@example.com");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
