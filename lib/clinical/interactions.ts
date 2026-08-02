import { db } from "../db";
import type { Allergy, Medication } from "@prisma/client";

/**
 * Module 6 — Medication safety engine.
 *
 * Three deterministic checks:
 *  1. drug ↔ drug interactions against the curated interaction table
 *  2. drug ↔ allergy conflicts including cross-reactivity classes
 *  3. therapeutic duplication (two active drugs in the same class)
 */

export type SafetyAlert = {
  level: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  kind: "interaction" | "allergy" | "duplication";
  title: string;
  detail: string;
  involves: string[];
};

/** Allergy cross-reactivity classes: allergen keyword -> drug members. */
const CROSS_REACTIVITY: Record<string, { members: string[]; note: string }> = {
  penicillin: {
    members: ["amoxicillin", "ampicillin", "piperacillin", "penicillin", "augmentin", "amoxicillin-clavulanate"],
    note: "Beta-lactam cross-reactivity with documented penicillin allergy.",
  },
  sulfa: {
    members: ["sulfamethoxazole", "trimethoprim-sulfamethoxazole", "sulfasalazine", "co-trimoxazole"],
    note: "Sulfonamide class cross-reactivity.",
  },
  aspirin: {
    members: ["aspirin", "ibuprofen", "naproxen", "ketorolac", "diclofenac"],
    note: "NSAID cross-reactivity in aspirin-sensitive patients.",
  },
  nsaid: {
    members: ["ibuprofen", "naproxen", "ketorolac", "diclofenac", "aspirin"],
    note: "NSAID class allergy.",
  },
  codeine: {
    members: ["codeine", "tramadol", "morphine", "oxycodone"],
    note: "Opioid class sensitivity.",
  },
};

const DRUG_CLASSES: Record<string, string[]> = {
  "ACE inhibitor": ["lisinopril", "enalapril", "ramipril", "captopril"],
  "ARB": ["losartan", "valsartan", "telmisartan"],
  "statin": ["atorvastatin", "simvastatin", "rosuvastatin", "pravastatin"],
  "beta blocker": ["metoprolol", "atenolol", "bisoprolol", "carvedilol"],
  "sulfonylurea": ["glipizide", "glyburide", "glimepiride"],
  "PPI": ["omeprazole", "pantoprazole", "esomeprazole"],
  "SSRI": ["sertraline", "fluoxetine", "escitalopram", "citalopram"],
  "anticoagulant": ["warfarin", "apixaban", "rivaroxaban", "dabigatran"],
};

const norm = (m: Medication) => (m.genericName ?? m.name).toLowerCase().trim();

export async function checkMedicationSafety(
  medications: Medication[],
  allergies: Allergy[],
  /** optionally test a proposed new drug against the current regimen */
  proposed?: { name: string },
): Promise<SafetyAlert[]> {
  const alerts: SafetyAlert[] = [];
  const active = medications.filter((m) => m.status === "ACTIVE");
  const names = active.map(norm);
  if (proposed) names.push(proposed.name.toLowerCase().trim());

  // 1. Pairwise interactions from the curated table
  const rows = await db.drugInteraction.findMany();
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const hit = rows.find(
        (r) =>
          (r.drugA === names[i] && r.drugB === names[j]) ||
          (r.drugA === names[j] && r.drugB === names[i]),
      );
      if (hit) {
        alerts.push({
          level: hit.severity,
          kind: "interaction",
          title: `${titleCase(names[i])} + ${titleCase(names[j])}`,
          detail: `${hit.mechanism} ${hit.advice}`,
          involves: [names[i], names[j]],
        });
      }
    }
  }

  // 2. Allergy conflicts with cross-reactivity
  for (const allergy of allergies) {
    const key = allergy.substance.toLowerCase().trim();
    const cls = CROSS_REACTIVITY[key];
    for (const drug of names) {
      const direct = drug.includes(key);
      const crossReactive = cls?.members.some((m) => drug.includes(m));
      if (direct || crossReactive) {
        alerts.push({
          level: allergy.severity === "CRITICAL" ? "CRITICAL" : "HIGH",
          kind: "allergy",
          title: `${titleCase(drug)} conflicts with documented ${titleCase(key)} allergy`,
          detail: direct
            ? `Patient has a documented ${key} allergy${allergy.reaction ? ` (prior reaction: ${allergy.reaction})` : ""}. ${titleCase(drug)} contains or is the allergen.`
            : `${cls!.note}${allergy.reaction ? ` Prior reaction: ${allergy.reaction}.` : ""} Consider a non-cross-reactive alternative.`,
          involves: [drug],
        });
      }
    }
  }

  // 3. Therapeutic duplication
  for (const [cls, members] of Object.entries(DRUG_CLASSES)) {
    const inClass = names.filter((n) => members.some((m) => n.includes(m)));
    if (new Set(inClass).size > 1) {
      alerts.push({
        level: "MEDIUM",
        kind: "duplication",
        title: `Two ${cls}s prescribed`,
        detail: `${inClass.map(titleCase).join(" and ")} are both ${cls}s. Verify this duplication is intentional.`,
        involves: inClass,
      });
    }
  }

  const order = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
  return alerts.sort((a, b) => order[a.level] - order[b.level]);
}

function titleCase(s: string) {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}
