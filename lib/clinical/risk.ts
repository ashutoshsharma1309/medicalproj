import type { Patient, Condition, Medication, LabValue, LabReport, Allergy } from "@prisma/client";
import { aiAvailable, complete, CLINICAL_SYSTEM, MODEL } from "../ai/client";

/**
 * Module 3 — Clinical decision support.
 *
 * Risk scores are computed by a transparent, weighted rule engine so every
 * point on the score maps to a named factor with cited evidence — the score
 * is explainable by construction, not explained after the fact. The LLM
 * (when configured) writes the clinician-facing narrative on top of the
 * deterministic result; it never changes the numbers.
 */

export type RiskFactor = { label: string; weightPct: number; evidence: string };
export type RiskResult = {
  domain: string;
  score: number; // 0–100
  band: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  factors: RiskFactor[];
  recommendations: string[];
  narrative: string | null;
  engine: string;
};

type PatientBundle = Patient & {
  conditions: Condition[];
  medications: Medication[];
  allergies: Allergy[];
  labReports: (LabReport & { values: LabValue[] })[];
};

function latest(bundle: PatientBundle, analyte: string): LabValue | null {
  const reports = [...bundle.labReports].sort(
    (a, b) => b.collectedAt.getTime() - a.collectedAt.getTime(),
  );
  for (const r of reports) {
    const v = r.values.find((x) => x.analyte.toLowerCase() === analyte.toLowerCase());
    if (v) return v;
  }
  return null;
}

function age(p: Patient): number {
  return Math.floor((Date.now() - p.dateOfBirth.getTime()) / 31557600000);
}

const band = (score: number) =>
  score >= 75 ? "CRITICAL" : score >= 50 ? "HIGH" : score >= 25 ? "MEDIUM" : "LOW";

type Rule = { points: number; label: string; evidence: string };

function scoreFromRules(domain: string, rules: Rule[], recommendations: string[]): RiskResult {
  const hits = rules.filter((r) => r.points > 0);
  const raw = hits.reduce((s, r) => s + r.points, 0);
  const score = Math.min(100, raw);
  const total = hits.reduce((s, r) => s + r.points, 0) || 1;
  const factors = hits
    .sort((a, b) => b.points - a.points)
    .map((r) => ({
      label: r.label,
      weightPct: Math.round((r.points / total) * 100),
      evidence: r.evidence,
    }));
  return {
    domain,
    score,
    band: band(score),
    factors,
    recommendations,
    narrative: null,
    engine: "rules-v1",
  };
}

export function cardiovascularRisk(b: PatientBundle): RiskResult {
  const a = age(b);
  const has = (name: string) =>
    b.conditions.some((c) => c.name.toLowerCase().includes(name) && c.status !== "RESOLVED");
  const ldl = latest(b, "LDL");
  const sbpCondition = has("hypertension");
  const bnp = latest(b, "BNP");
  const troponin = latest(b, "Troponin");

  const rules: Rule[] = [
    {
      points: sbpCondition ? 22 : 0,
      label: "Hypertension",
      evidence: "Active diagnosis of hypertension on the problem list.",
    },
    {
      points: has("diabetes") ? 20 : 0,
      label: "Diabetes history",
      evidence: "Diabetes mellitus on the problem list — independent CV risk multiplier.",
    },
    {
      points: a >= 65 ? 15 : a >= 50 ? 9 : 0,
      label: "Age factor",
      evidence: `Patient is ${a} years old.`,
    },
    {
      points: b.smoker ? 12 : 0,
      label: "Active smoking",
      evidence: "Current smoker documented in social history.",
    },
    {
      points: ldl && ldl.value >= 160 ? 14 : ldl && ldl.value >= 130 ? 8 : 0,
      label: "Elevated LDL cholesterol",
      evidence: ldl ? `Most recent LDL ${ldl.value} ${ldl.unit} (target < 100).` : "",
    },
    {
      points: has("coronary") || has("heart failure") || has("atrial fibrillation") ? 20 : 0,
      label: "Established cardiac disease",
      evidence: "Existing cardiac diagnosis on the problem list.",
    },
    {
      points: bnp && bnp.value > 100 ? 12 : 0,
      label: "Elevated BNP",
      evidence: bnp ? `BNP ${bnp.value} ${bnp.unit} (ref < 100) — suggests ventricular strain.` : "",
    },
    {
      points: troponin && troponin.value > 0.04 ? 25 : 0,
      label: "Elevated troponin",
      evidence: troponin ? `Troponin ${troponin.value} ${troponin.unit} above the 99th percentile.` : "",
    },
    {
      points: (b.weightKg ?? 0) > 0 && (b.heightCm ?? 0) > 0 && bmi(b) >= 30 ? 8 : 0,
      label: "Obesity",
      evidence: b.weightKg && b.heightCm ? `BMI ${bmi(b).toFixed(1)} kg/m².` : "",
    },
  ];

  return scoreFromRules("cardiovascular", rules, [
    "Confirm blood-pressure control against guideline target (<130/80 for most comorbid patients).",
    "Review lipid panel; consider statin initiation or intensification if LDL above target.",
    "Reinforce smoking cessation counselling where applicable.",
    "Consider 12-lead ECG and echocardiography if new symptoms or rising biomarkers.",
  ]);
}

export function metabolicRisk(b: PatientBundle): RiskResult {
  const hba1c = latest(b, "HbA1c");
  const glucose = latest(b, "Glucose") ?? latest(b, "Fasting Glucose");
  const egfr = latest(b, "eGFR");
  const has = (name: string) =>
    b.conditions.some((c) => c.name.toLowerCase().includes(name) && c.status !== "RESOLVED");

  const rules: Rule[] = [
    {
      points: hba1c && hba1c.value >= 9 ? 30 : hba1c && hba1c.value >= 8 ? 22 : hba1c && hba1c.value >= 6.5 ? 12 : 0,
      label: "Glycemic control",
      evidence: hba1c ? `Most recent HbA1c ${hba1c.value}% (target ≤ 7.0% for most adults).` : "",
    },
    {
      points: glucose && glucose.value >= 180 ? 15 : glucose && glucose.value >= 126 ? 8 : 0,
      label: "High glucose",
      evidence: glucose ? `Glucose ${glucose.value} ${glucose.unit} (ref 70–99).` : "",
    },
    {
      points: has("diabetes") ? 15 : 0,
      label: "Diabetes diagnosis",
      evidence: "Diabetes mellitus on the problem list.",
    },
    {
      points: egfr && egfr.value < 45 ? 20 : egfr && egfr.value < 60 ? 12 : 0,
      label: "Reduced kidney function",
      evidence: egfr ? `eGFR ${egfr.value} mL/min — below the CKD threshold of 60.` : "",
    },
    {
      points: (b.weightKg ?? 0) > 0 && (b.heightCm ?? 0) > 0 && bmi(b) >= 30 ? 10 : 0,
      label: "Obesity",
      evidence: b.weightKg && b.heightCm ? `BMI ${bmi(b).toFixed(1)} kg/m².` : "",
    },
    {
      points: has("hypertension") ? 8 : 0,
      label: "Hypertension",
      evidence: "Co-existing hypertension compounds metabolic risk.",
    },
  ];

  return scoreFromRules("metabolic", rules, [
    "If HbA1c above individualized target on two consecutive results, intensify therapy per stepwise guideline.",
    "Annual urine albumin/creatinine ratio and eGFR to monitor for diabetic kidney disease.",
    "Dietitian referral and structured self-monitoring where control is deteriorating.",
  ]);
}

function bmi(b: PatientBundle) {
  const h = (b.heightCm ?? 0) / 100;
  return h > 0 ? (b.weightKg ?? 0) / (h * h) : 0;
}

export async function assessRisks(bundle: PatientBundle): Promise<RiskResult[]> {
  const results = [cardiovascularRisk(bundle), metabolicRisk(bundle)];

  if (aiAvailable()) {
    for (const r of results) {
      try {
        r.narrative = await complete({
          system: CLINICAL_SYSTEM,
          prompt: `A deterministic rule engine scored this patient's ${r.domain} risk at ${r.score}/100 (${r.band}). Contributing factors:\n${r.factors
            .map((f) => `- ${f.label} (${f.weightPct}% of score): ${f.evidence}`)
            .join("\n")}\n\nWrite a 3–4 sentence clinician-facing interpretation. Do not restate every number; explain what matters most and what to watch. Do not change or re-estimate the score.`,
          maxTokens: 500,
        });
        r.engine = `rules-v1 + ${MODEL}`;
      } catch {
        /* keep deterministic result */
      }
    }
  }
  return results;
}
