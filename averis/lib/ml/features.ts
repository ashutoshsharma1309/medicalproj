import type { DigitalTwin, ConfirmedRecordRow } from "@/lib/services/twin/types";
import type { DerivedValue } from "./predict";
import type { RiskModel } from "./types";

/**
 * Feature extraction from the Patient Digital Twin.
 *
 * The Phase 3 twin is already the assembled, patient-confirmed picture of a
 * record, so the risk models read from it rather than re-querying documents.
 * Nothing here infers a clinical fact — it reads values the patient has
 * already confirmed and maps them onto the columns each model was trained on.
 *
 * Two rules govern everything below.
 *
 * **Only map what genuinely matches.** HbA1c is not plasma glucose, and LDL is
 * not total cholesterol. Feeding one in place of the other would produce a
 * confident number computed from the wrong quantity, which is worse than
 * admitting the value is missing and imputing it openly.
 *
 * **Prefer the most recent reading.** A glucose from 2019 says little about
 * risk today, so measurements are taken newest-first.
 */

/** Matchers are deliberately narrow. When in doubt, do not map. */
const LAB_MATCHERS: Record<string, RegExp> = {
  glucose: /\b(?:fasting\s+)?(?:plasma\s+|blood\s+)?glucose\b|\bfbs\b|\bfasting blood sugar\b/i,
  cholesterol: /\b(?:total\s+)?cholesterol\b/i,
  insulin: /\bserum\s+insulin\b|\binsulin\b/i,
  bmi: /\bbmi\b|\bbody mass index\b/i,
  systolic: /\bsystolic\b|\bblood pressure\b|\bbp\b/i,
  diastolic: /\bdiastolic\b/i,
  heartRate: /\b(?:max(?:imum)?\s+)?heart rate\b|\bpulse\b/i,
};

export function extractFeatures(
  model: RiskModel,
  twin: DigitalTwin,
  records: ConfirmedRecordRow[],
): Record<string, DerivedValue | undefined> {
  return model === "diabetes"
    ? diabetesFeatures(twin, records)
    : cardiovascularFeatures(twin, records);
}

/* ---------------------------------------------------------------- diabetes */

function diabetesFeatures(
  twin: DigitalTwin,
  records: ConfirmedRecordRow[],
): Record<string, DerivedValue | undefined> {
  const bloodPressure = latestBloodPressure(records);

  return {
    glucose: latestLab(records, "glucose"),
    insulin: latestLab(records, "insulin"),
    bmi: latestLab(records, "bmi"),
    // The Pima model's blood pressure column is diastolic. Handing it a
    // systolic reading would shift every patient by roughly 40 mm Hg.
    blood_pressure: bloodPressure.diastolic,
    age: twin.age !== null ? { value: twin.age, sourceLabel: "Your date of birth" } : undefined,
    // Pregnancy count, skinfold thickness and the Pima pedigree score are not
    // in an AVERIS record. They are imputed, and the confidence figure says so.
    pregnancies: undefined,
    skin_thickness: undefined,
    diabetes_pedigree: undefined,
  };
}

/* ---------------------------------------------------------- cardiovascular */

function cardiovascularFeatures(
  twin: DigitalTwin,
  records: ConfirmedRecordRow[],
): Record<string, DerivedValue | undefined> {
  const bloodPressure = latestBloodPressure(records);
  const glucose = latestLab(records, "glucose");

  return {
    age: twin.age !== null ? { value: twin.age, sourceLabel: "Your date of birth" } : undefined,
    sex: sexFeature(twin),
    resting_bp: bloodPressure.systolic,
    cholesterol: latestLab(records, "cholesterol"),
    // The Cleveland column is a flag, not a level: fasting blood sugar above
    // 120 mg/dL. Deriving the flag from a glucose reading is arithmetic.
    fasting_blood_sugar: glucose
      ? {
          value: glucose.value > 120 ? 1 : 0,
          sourceLabel: `Derived from your glucose reading of ${glucose.value}`,
        }
      : undefined,
    max_heart_rate: latestLab(records, "heartRate"),
    // Chest pain type, exercise-induced angina and ST depression come from a
    // supervised exercise test. Nothing in a patient's uploaded documents
    // stands in for them.
    chest_pain_type: undefined,
    exercise_angina: undefined,
    st_depression: undefined,
  };
}

function sexFeature(twin: DigitalTwin): DerivedValue | undefined {
  // Cleveland encodes 1 = male, 0 = female. The dataset offers no third
  // value, so a patient who recorded anything else is imputed rather than
  // forced into a category the model would misread.
  const gender = twin.profile.gender;
  if (gender === "MALE") return { value: 1, sourceLabel: "Your health profile" };
  if (gender === "FEMALE") return { value: 0, sourceLabel: "Your health profile" };
  return undefined;
}

/* ------------------------------------------------------------------ labs */

function latestLab(records: ConfirmedRecordRow[], key: string): DerivedValue | undefined {
  const matcher = LAB_MATCHERS[key];
  if (!matcher) return undefined;

  const candidates = records
    .filter((r) => r.record_type === "LAB_RESULT" && r.test_name && r.test_value)
    .filter((r) => matcher.test(r.test_name!))
    .sort((a, b) => (b.record_date ?? b.created_at).localeCompare(a.record_date ?? a.created_at));

  for (const candidate of candidates) {
    const value = parseNumeric(candidate.test_value!);
    if (value === null) continue;
    return {
      value,
      sourceLabel: `${candidate.test_name!.trim()} from ${
        candidate.record_date ?? candidate.created_at.slice(0, 10)
      }`,
    };
  }

  return undefined;
}

/**
 * Blood pressure is recorded as "128/82", so the two components have to be
 * split before either model can use one. Which half matters depends on the
 * model, and getting it backwards is silent — both numbers are plausible
 * pressures.
 */
function latestBloodPressure(records: ConfirmedRecordRow[]): {
  systolic?: DerivedValue;
  diastolic?: DerivedValue;
} {
  const candidates = records
    .filter((r) => r.record_type === "LAB_RESULT" && r.test_name && r.test_value)
    .filter((r) => LAB_MATCHERS.systolic.test(r.test_name!) || LAB_MATCHERS.diastolic.test(r.test_name!))
    .sort((a, b) => (b.record_date ?? b.created_at).localeCompare(a.record_date ?? a.created_at));

  for (const candidate of candidates) {
    const raw = candidate.test_value!;
    const date = candidate.record_date ?? candidate.created_at.slice(0, 10);
    const source = `${candidate.test_name!.trim()} from ${date}`;

    const paired = raw.match(/(\d{2,3})\s*\/\s*(\d{2,3})/);
    if (paired) {
      return {
        systolic: { value: Number(paired[1]), sourceLabel: source },
        diastolic: { value: Number(paired[2]), sourceLabel: source },
      };
    }

    const single = parseNumeric(raw);
    if (single === null) continue;

    // A lone number is only usable when the test name says which half it is.
    if (LAB_MATCHERS.diastolic.test(candidate.test_name!)) {
      return { diastolic: { value: single, sourceLabel: source } };
    }
    if (/\bsystolic\b/i.test(candidate.test_name!)) {
      return { systolic: { value: single, sourceLabel: source } };
    }
  }

  return {};
}

function parseNumeric(value: string): number | null {
  const match = value.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const parsed = Number.parseFloat(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}
