import { z } from "zod";
import { BLOOD_GROUP_OPTIONS, GENDER_OPTIONS } from "@/lib/utils/constants";

/**
 * Validation shared by client and server. Server Actions re-run these schemas
 * regardless of what the browser sent — client validation is UX, not security.
 */

const genderValues = GENDER_OPTIONS.map((o) => o.value) as [string, ...string[]];
const bloodGroupValues = BLOOD_GROUP_OPTIONS.map((o) => o.value) as [string, ...string[]];

export const emailSchema = z
  .string()
  .trim()
  .min(1, "Enter your email address.")
  .email("Enter a valid email address.");

export const passwordSchema = z
  .string()
  .min(8, "Use at least 8 characters.")
  .regex(/[A-Za-z]/, "Include at least one letter.")
  .regex(/[0-9]/, "Include at least one number.");

export const signUpSchema = z
  .object({
    fullName: z.string().trim().min(2, "Enter your full name.").max(120),
    email: emailSchema,
    password: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((d) => d.password === d.confirmPassword, {
    message: "Passwords do not match.",
    path: ["confirmPassword"],
  });

export const signInSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "Enter your password."),
});

/** Onboarding step 1 — personal information. */
export const personalInfoSchema = z.object({
  fullName: z.string().trim().min(2, "Enter your full name.").max(120),
  dateOfBirth: z
    .string()
    .min(1, "Enter your date of birth.")
    .refine((value) => {
      const date = new Date(value);
      return (
        !Number.isNaN(date.getTime()) &&
        date < new Date() &&
        date > new Date("1900-01-01")
      );
    }, "Enter a valid date of birth."),
  gender: z.enum(genderValues, { message: "Select an option." }),
  phoneNumber: z
    .string()
    .trim()
    .min(7, "Enter a valid phone number.")
    .max(24, "Enter a valid phone number."),
});

/** Onboarding step 2 — basic health information. */
export const healthInfoSchema = z.object({
  bloodGroup: z.enum(bloodGroupValues, { message: "Select a blood group." }),
  allergies: z.array(z.string().trim().min(1).max(120)).max(50).default([]),
  existingConditions: z.array(z.string().trim().min(1).max(120)).max(50).default([]),
  currentMedications: z.array(z.string().trim().min(1).max(160)).max(50).default([]),
  emergencyContact: z.string().trim().max(160).optional().default(""),
  medicalNotes: z.string().trim().max(2000).optional().default(""),
});

/** Full onboarding payload submitted at the end of the wizard. */
export const onboardingSchema = personalInfoSchema.extend(healthInfoSchema.shape);

export type PersonalInfoInput = z.infer<typeof personalInfoSchema>;
export type HealthInfoInput = z.infer<typeof healthInfoSchema>;
export type OnboardingInput = z.infer<typeof onboardingSchema>;

/** Splits a free-text list ("Penicillin, Peanuts") into clean entries. */
export function parseList(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 50);
}
