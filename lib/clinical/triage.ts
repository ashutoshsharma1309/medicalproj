/**
 * Module 5 — Emergency triage scoring.
 *
 * An ESI-inspired weighted rubric: every point is attributable to a vital
 * sign, symptom or history element, so the queue ordering can be defended
 * to the charge nurse line by line.
 */

export type Vitals = {
  hr: number; // heart rate bpm
  sbp: number; // systolic BP mmHg
  dbp: number;
  rr: number; // respiratory rate /min
  spo2: number; // %
  tempC: number;
  gcs?: number; // Glasgow coma scale 3-15
};

export type TriageInput = {
  ageYears: number;
  chiefComplaint: string;
  symptoms: string[];
  vitals: Vitals;
  history: string[]; // condition names
};

export type TriageRationale = { factor: string; points: number; why: string };

export type TriageResult = {
  score: number; // 0-100
  acuity: 1 | 2 | 3 | 4 | 5;
  priority: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  rationale: TriageRationale[];
  disposition: string;
};

const RED_FLAG_SYMPTOMS: Record<string, [number, string]> = {
  "chest pain": [18, "Possible acute coronary syndrome until excluded."],
  "shortness of breath": [14, "Respiratory compromise risk."],
  "altered mental status": [20, "Neurological emergency until excluded."],
  "syncope": [12, "Cardiac or neurological cause must be excluded."],
  "severe bleeding": [22, "Hemodynamic compromise risk."],
  "stroke symptoms": [24, "Time-critical reperfusion window."],
  "facial droop": [24, "Stroke red flag — time-critical."],
  "slurred speech": [20, "Stroke red flag."],
  "severe abdominal pain": [10, "Surgical abdomen must be excluded."],
  "seizure": [16, "Post-ictal monitoring and cause work-up required."],
  "anaphylaxis": [26, "Airway threat — immediate treatment."],
  "high fever": [8, "Sepsis screening indicated."],
  "vomiting blood": [20, "GI bleed — hemodynamic risk."],
};

export function scoreTriage(input: TriageInput): TriageResult {
  const r: TriageRationale[] = [];
  const v = input.vitals;
  const add = (factor: string, points: number, why: string) => {
    if (points > 0) r.push({ factor, points, why });
  };

  // Vital signs
  if (v.spo2 < 90) add("Oxygen saturation", 25, `SpO₂ ${v.spo2}% — significant hypoxia (ref ≥ 95%).`);
  else if (v.spo2 < 94) add("Oxygen saturation", 12, `SpO₂ ${v.spo2}% — mild hypoxia.`);

  if (v.sbp < 90) add("Blood pressure", 22, `Systolic ${v.sbp} mmHg — hypotension, shock risk.`);
  else if (v.sbp > 200 || v.dbp > 120) add("Blood pressure", 16, `BP ${v.sbp}/${v.dbp} — hypertensive crisis range.`);
  else if (v.sbp > 180) add("Blood pressure", 8, `Systolic ${v.sbp} mmHg — severely elevated.`);

  if (v.hr > 130) add("Heart rate", 14, `HR ${v.hr} bpm — marked tachycardia.`);
  else if (v.hr > 110) add("Heart rate", 8, `HR ${v.hr} bpm — tachycardia.`);
  else if (v.hr < 45) add("Heart rate", 14, `HR ${v.hr} bpm — bradycardia.`);

  if (v.rr > 28) add("Respiratory rate", 14, `RR ${v.rr}/min — respiratory distress.`);
  else if (v.rr > 22) add("Respiratory rate", 7, `RR ${v.rr}/min — elevated.`);

  if (v.tempC >= 39.5) add("Temperature", 8, `Temp ${v.tempC}°C — high fever, sepsis screen.`);
  else if (v.tempC <= 35) add("Temperature", 10, `Temp ${v.tempC}°C — hypothermia.`);

  if (v.gcs !== undefined && v.gcs < 15) {
    add("Consciousness", v.gcs <= 12 ? 24 : 10, `GCS ${v.gcs} — reduced level of consciousness.`);
  }

  // Symptoms
  for (const s of input.symptoms) {
    const key = s.toLowerCase().trim();
    const hit = RED_FLAG_SYMPTOMS[key];
    if (hit) add(titleCase(key), hit[0], hit[1]);
  }

  // Age & history modifiers
  if (input.ageYears >= 75) add("Age", 8, `${input.ageYears} years — reduced physiological reserve.`);
  else if (input.ageYears >= 65) add("Age", 5, `${input.ageYears} years.`);
  else if (input.ageYears < 2) add("Age", 10, "Infant — low reserve, subtle deterioration.");

  const hist = input.history.map((h) => h.toLowerCase());
  const riskyHistory: [string, string][] = [
    ["diabetes", "Diabetes can mask ischemic pain and worsens infection outcomes."],
    ["heart failure", "Cardiac history raises decompensation risk."],
    ["coronary", "Known coronary disease raises ACS probability."],
    ["copd", "Chronic lung disease lowers respiratory reserve."],
    ["chronic kidney", "Renal impairment complicates fluid and drug management."],
    ["immunosuppress", "Immunosuppression elevates sepsis risk."],
  ];
  for (const [term, why] of riskyHistory) {
    if (hist.some((h) => h.includes(term))) add(`History: ${titleCase(term)}`, 5, why);
  }

  const score = Math.min(100, r.reduce((s, x) => s + x.points, 0));
  const acuity: TriageResult["acuity"] =
    score >= 70 ? 1 : score >= 45 ? 2 : score >= 25 ? 3 : score >= 10 ? 4 : 5;
  const priority =
    acuity === 1 ? "CRITICAL" : acuity === 2 ? "HIGH" : acuity === 3 ? "MEDIUM" : "LOW";

  const disposition =
    acuity === 1
      ? "Immediate — move to resuscitation bay, notify senior physician now."
      : acuity === 2
        ? "Emergent — physician assessment within 10 minutes, continuous monitoring."
        : acuity === 3
          ? "Urgent — assessment within 30 minutes, repeat vitals every 30 minutes."
          : acuity === 4
            ? "Less urgent — assessment within 60 minutes."
            : "Non-urgent — suitable for fast-track or clinic redirection.";

  return { score, acuity, priority, rationale: r.sort((a, b) => b.points - a.points), disposition };
}

function titleCase(s: string) {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}
