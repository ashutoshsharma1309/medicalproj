/** Shared option sets. Values match the Postgres enums in the AVERIS schema. */

export const GENDER_OPTIONS = [
  { value: "FEMALE", label: "Female" },
  { value: "MALE", label: "Male" },
  { value: "OTHER", label: "Other" },
  { value: "PREFER_NOT_TO_SAY", label: "Prefer not to say" },
] as const;

export const BLOOD_GROUP_OPTIONS = [
  { value: "A_POSITIVE", label: "A+" },
  { value: "A_NEGATIVE", label: "A−" },
  { value: "B_POSITIVE", label: "B+" },
  { value: "B_NEGATIVE", label: "B−" },
  { value: "AB_POSITIVE", label: "AB+" },
  { value: "AB_NEGATIVE", label: "AB−" },
  { value: "O_POSITIVE", label: "O+" },
  { value: "O_NEGATIVE", label: "O−" },
  { value: "UNKNOWN", label: "Not known yet" },
] as const;

export type GenderValue = (typeof GENDER_OPTIONS)[number]["value"];
export type BloodGroupValue = (typeof BLOOD_GROUP_OPTIONS)[number]["value"];

export function bloodGroupLabel(value: string | null | undefined): string {
  return BLOOD_GROUP_OPTIONS.find((o) => o.value === value)?.label ?? "—";
}

export function genderLabel(value: string | null | undefined): string {
  return GENDER_OPTIONS.find((o) => o.value === value)?.label ?? "—";
}
