import { aiAvailable, completeJson, CLINICAL_SYSTEM, MODEL } from "./client";

/**
 * Module 1 / Module 4 — Patient Intelligence extraction.
 * Turns unstructured medical documents (lab reports, prescriptions,
 * discharge summaries) into a structured intelligence payload.
 */

export type Extraction = {
  patientName: string | null;
  documentType: string;
  conditions: string[];
  symptoms: string[];
  allergies: string[];
  medications: { name: string; dose: string | null; frequency: string | null }[];
  labValues: {
    analyte: string;
    value: number;
    unit: string;
    refLow: number | null;
    refHigh: number | null;
    flag: "H" | "L" | null;
  }[];
  riskFactors: string[];
  keyFindings: string[];
  summary: string;
};

const EXTRACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "patientName",
    "documentType",
    "conditions",
    "symptoms",
    "allergies",
    "medications",
    "labValues",
    "riskFactors",
    "keyFindings",
    "summary",
  ],
  properties: {
    patientName: { type: ["string", "null"] },
    documentType: {
      type: "string",
      enum: ["lab_report", "prescription", "discharge_summary", "referral", "other"],
    },
    conditions: { type: "array", items: { type: "string" } },
    symptoms: { type: "array", items: { type: "string" } },
    allergies: { type: "array", items: { type: "string" } },
    medications: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "dose", "frequency"],
        properties: {
          name: { type: "string" },
          dose: { type: ["string", "null"] },
          frequency: { type: ["string", "null"] },
        },
      },
    },
    labValues: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["analyte", "value", "unit", "refLow", "refHigh", "flag"],
        properties: {
          analyte: { type: "string" },
          value: { type: "number" },
          unit: { type: "string" },
          refLow: { type: ["number", "null"] },
          refHigh: { type: ["number", "null"] },
          flag: { type: ["string", "null"], enum: ["H", "L", null] },
        },
      },
    },
    riskFactors: { type: "array", items: { type: "string" } },
    keyFindings: { type: "array", items: { type: "string" } },
    summary: { type: "string" },
  },
};

export async function extractDocument(
  rawText: string,
): Promise<{ extraction: Extraction; engine: string }> {
  if (aiAvailable()) {
    const extraction = await completeJson<Extraction>({
      system: CLINICAL_SYSTEM,
      prompt: `Extract structured patient intelligence from the following medical document. Only extract facts literally present in the text — never infer values. Flag a lab value "H" or "L" only when it falls outside the stated or standard reference range. In "summary" write 2–3 sentences a physician would want first.

<document>
${rawText.slice(0, 30000)}
</document>`,
      schema: EXTRACTION_SCHEMA,
      maxTokens: 6000,
    });
    return { extraction, engine: MODEL };
  }
  return { extraction: deterministicExtract(rawText), engine: "deterministic-parser-v1" };
}

/* ----------------------------------------------------------------------- */
/* Deterministic fallback parser — pattern-based extraction that handles    */
/* the common shape of typed lab reports and discharge summaries.           */
/* ----------------------------------------------------------------------- */

const CONDITION_TERMS = [
  "diabetes", "hypertension", "asthma", "copd", "coronary artery disease",
  "heart failure", "atrial fibrillation", "hyperlipidemia", "hypothyroidism",
  "chronic kidney disease", "ckd", "anemia", "obesity", "depression",
  "gerd", "osteoarthritis", "stroke", "pneumonia", "sepsis", "angina",
];
const SYMPTOM_TERMS = [
  "chest pain", "shortness of breath", "dyspnea", "fatigue", "dizziness",
  "palpitations", "headache", "nausea", "vomiting", "fever", "cough",
  "polyuria", "polydipsia", "blurred vision", "edema", "syncope", "weakness",
];
const KNOWN_ANALYTES: Record<string, [number, number, string]> = {
  "hba1c": [4.0, 5.6, "%"],
  "glucose": [70, 99, "mg/dL"],
  "fasting glucose": [70, 99, "mg/dL"],
  "creatinine": [0.7, 1.3, "mg/dL"],
  "egfr": [90, 120, "mL/min"],
  "ldl": [0, 100, "mg/dL"],
  "hdl": [40, 90, "mg/dL"],
  "triglycerides": [0, 150, "mg/dL"],
  "total cholesterol": [0, 200, "mg/dL"],
  "hemoglobin": [12.0, 17.5, "g/dL"],
  "wbc": [4.5, 11.0, "10^3/uL"],
  "platelets": [150, 400, "10^3/uL"],
  "sodium": [135, 145, "mmol/L"],
  "potassium": [3.5, 5.1, "mmol/L"],
  "tsh": [0.4, 4.0, "mIU/L"],
  "bnp": [0, 100, "pg/mL"],
  "troponin": [0, 0.04, "ng/mL"],
  "alt": [7, 56, "U/L"],
  "ast": [10, 40, "U/L"],
};

export function deterministicExtract(rawText: string): Extraction {
  const text = rawText.toLowerCase();
  const lines = rawText.split(/\r?\n/);

  const found = (terms: string[]) =>
    [...new Set(terms.filter((t) => text.includes(t)))].map(titleCase);

  // Lab values: "HbA1c: 8.5 %"  |  "Glucose 182 mg/dL (70-99)"
  const labValues: Extraction["labValues"] = [];
  for (const [analyte, [lo, hi, unit]] of Object.entries(KNOWN_ANALYTES)) {
    const re = new RegExp(
      `${analyte.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[:=]?\\s*(\\d+(?:\\.\\d+)?)`,
      "i",
    );
    const m = rawText.match(re);
    if (m) {
      const value = parseFloat(m[1]);
      labValues.push({
        analyte: analyte === "hba1c" ? "HbA1c" : titleCase(analyte),
        value,
        unit,
        refLow: lo,
        refHigh: hi,
        flag: value > hi ? "H" : value < lo ? "L" : null,
      });
    }
  }

  // Medications: "Metformin 500 mg twice daily" / "- Lisinopril 10mg OD"
  const medications: Extraction["medications"] = [];
  const medRe =
    /^[-•*\s]*([A-Z][a-zA-Z]{3,})\s+(\d+(?:\.\d+)?\s?(?:mg|mcg|g|units?|iu))\b\s*(.*)$/;
  for (const line of lines) {
    const m = line.trim().match(medRe);
    if (m && !/(glucose|sodium|potassium|creatinine|hemoglobin)/i.test(m[1])) {
      medications.push({
        name: m[1],
        dose: m[2],
        frequency: m[3]?.trim() || null,
      });
    }
  }

  // Allergies: "Allergies: Penicillin, Sulfa"
  const allergies: string[] = [];
  const allergyLine = rawText.match(/allerg(?:y|ies)\s*[:\-]\s*(.+)/i);
  if (allergyLine && !/none|nkda|no known/i.test(allergyLine[1])) {
    allergies.push(
      ...allergyLine[1].split(/[,;]/).map((s) => titleCase(s.trim())).filter(Boolean),
    );
  }

  const nameLine = rawText.match(/(?:patient|name)\s*[:\-]\s*([A-Z][a-zA-Z]+(?: [A-Z][a-zA-Z]+)+)/i);
  const conditions = found(CONDITION_TERMS);
  const abnormal = labValues.filter((v) => v.flag);

  const riskFactors = [
    ...abnormal.map((v) => `${v.analyte} ${v.flag === "H" ? "elevated" : "low"} (${v.value} ${v.unit})`),
    ...(text.includes("smok") && !text.includes("non-smok") ? ["Active smoker"] : []),
    ...(conditions.includes("Diabetes") ? ["Diabetes history"] : []),
    ...(conditions.includes("Hypertension") ? ["Hypertensive"] : []),
  ];

  const documentType = /discharge/i.test(rawText)
    ? "discharge_summary"
    : /prescription|rx\b/i.test(rawText)
      ? "prescription"
      : labValues.length > 0
        ? "lab_report"
        : "other";

  return {
    patientName: nameLine?.[1] ?? null,
    documentType,
    conditions,
    symptoms: found(SYMPTOM_TERMS),
    allergies,
    medications,
    labValues,
    riskFactors: [...new Set(riskFactors)],
    keyFindings: abnormal.map(
      (v) =>
        `${v.analyte} ${v.value} ${v.unit} — ${v.flag === "H" ? "above" : "below"} reference range (${v.refLow}–${v.refHigh})`,
    ),
    summary:
      abnormal.length > 0
        ? `Parsed ${labValues.length} lab value(s); ${abnormal.length} outside reference range: ${abnormal.map((v) => v.analyte).join(", ")}. ${conditions.length > 0 ? "Documented conditions: " + conditions.join(", ") + "." : ""}`
        : `Parsed document. ${conditions.length > 0 ? "Documented conditions: " + conditions.join(", ") + "." : "No abnormal values detected by the rule parser."}`,
  };
}

function titleCase(s: string) {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}
