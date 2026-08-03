import {
  type ReviewItem,
  type ReviewSubmission,
  type ReviewItemKind,
} from "./types";

/**
 * Turns the patient's review decisions into the rows and profile updates that
 * follow from them.
 *
 * Pure by design: no Supabase client, no I/O. The rule that matters most in
 * this codebase — *nothing reaches a health profile without an explicit
 * confirmation* — is therefore directly unit-testable.
 */

export type ConfirmedRecord = {
  record_type: ReviewItemKind;
  condition: string | null;
  medication: string | null;
  allergy: string | null;
  test_name: string | null;
  test_value: string | null;
  test_unit: string | null;
  reference_range: string | null;
  confidence_score: number;
};

export type ReconciliationPlan = {
  /** Rows for patient_medical_records. */
  records: ConfirmedRecord[];
  /** Additive merges into patient_health_information. */
  profileAdditions: {
    conditions: string[];
    medications: string[];
    allergies: string[];
  };
  confirmedCount: number;
  rejectedCount: number;
};

/**
 * @param items       what the pipeline extracted
 * @param submissions what the patient decided, keyed by item id
 * @param existing    what is already on the health profile, so merges are additive
 */
export function buildReconciliationPlan(
  items: ReviewItem[],
  submissions: ReviewSubmission[],
  existing: {
    conditions: string[];
    medications: string[];
    allergies: string[];
  },
): ReconciliationPlan {
  const decisions = new Map(submissions.map((s) => [s.id, s]));

  const records: ConfirmedRecord[] = [];
  const additions = {
    conditions: [] as string[],
    medications: [] as string[],
    allergies: [] as string[],
  };

  let confirmedCount = 0;
  let rejectedCount = 0;

  // Case-insensitive membership so "Diabetes" does not duplicate "diabetes".
  const seen = {
    conditions: new Set(existing.conditions.map(normalize)),
    medications: new Set(existing.medications.map(normalize)),
    allergies: new Set(existing.allergies.map(normalize)),
  };

  for (const item of items) {
    const decision = decisions.get(item.id);

    // Absent or explicitly rejected — nothing is written. Silence is not consent.
    if (!decision || decision.decision !== "CONFIRM") {
      rejectedCount++;
      continue;
    }

    const edited = decision.editedLabel?.trim();
    const label = edited && edited.length > 0 ? edited : item.label;
    confirmedCount++;

    switch (item.kind) {
      case "CONDITION": {
        records.push(blankRecord("CONDITION", item.confidence, { condition: label }));
        if (!seen.conditions.has(normalize(label))) {
          seen.conditions.add(normalize(label));
          additions.conditions.push(label);
        }
        break;
      }
      case "MEDICATION": {
        records.push(blankRecord("MEDICATION", item.confidence, { medication: label }));
        if (!seen.medications.has(normalize(label))) {
          seen.medications.add(normalize(label));
          additions.medications.push(label);
        }
        break;
      }
      case "ALLERGY": {
        records.push(blankRecord("ALLERGY", item.confidence, { allergy: label }));
        if (!seen.allergies.has(normalize(label))) {
          seen.allergies.add(normalize(label));
          additions.allergies.push(label);
        }
        break;
      }
      case "LAB_RESULT": {
        // Lab values are point-in-time measurements, not standing facts, so
        // they become records but never join the profile's summary lists.
        records.push(
          blankRecord("LAB_RESULT", item.confidence, {
            test_name: item.detail.test_name ?? label,
            test_value: item.detail.test_value ?? null,
            test_unit: item.detail.test_unit ?? null,
            reference_range: item.detail.reference_range ?? null,
          }),
        );
        break;
      }
    }
  }

  return {
    records,
    profileAdditions: additions,
    confirmedCount,
    rejectedCount,
  };
}

/** Merge additions into an existing list without reordering or removing. */
export function mergeList(existing: string[], additions: string[]): string[] {
  const seen = new Set(existing.map(normalize));
  const merged = [...existing];
  for (const addition of additions) {
    if (!seen.has(normalize(addition))) {
      seen.add(normalize(addition));
      merged.push(addition);
    }
  }
  return merged;
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function blankRecord(
  kind: ReviewItemKind,
  confidence: number,
  fields: Partial<Omit<ConfirmedRecord, "record_type" | "confidence_score">>,
): ConfirmedRecord {
  return {
    record_type: kind,
    condition: null,
    medication: null,
    allergy: null,
    test_name: null,
    test_value: null,
    test_unit: null,
    reference_range: null,
    confidence_score: confidence,
    ...fields,
  };
}
