"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Field, Input, Select, TextArea, Callout, Card } from "@/components/ui";
import { BLOOD_GROUP_OPTIONS, GENDER_OPTIONS } from "@/lib/utils/constants";
import { personalInfoSchema, healthInfoSchema, parseList } from "@/lib/validation/patient";
import { completeOnboardingAction } from "./actions";

const STEPS = [
  { n: 1, label: "Personal information" },
  { n: 2, label: "Health information" },
  { n: 3, label: "Confirmation" },
] as const;

type Errors = Record<string, string>;

export function OnboardingWizard({ defaultFullName }: { defaultFullName: string }) {
  const router = useRouter();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [errors, setErrors] = useState<Errors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const [form, setForm] = useState({
    fullName: defaultFullName,
    dateOfBirth: "",
    gender: "",
    phoneNumber: "",
    bloodGroup: "",
    allergies: "",
    existingConditions: "",
    currentMedications: "",
    emergencyContact: "",
    medicalNotes: "",
  });

  const set =
    (key: keyof typeof form) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setForm((f) => ({ ...f, [key]: e.target.value }));

  function collectErrors(issues: { path: PropertyKey[]; message: string }[]): Errors {
    const next: Errors = {};
    for (const issue of issues) {
      const key = String(issue.path[0] ?? "");
      if (key && !next[key]) next[key] = issue.message;
    }
    return next;
  }

  function goToStepTwo() {
    const result = personalInfoSchema.safeParse({
      fullName: form.fullName,
      dateOfBirth: form.dateOfBirth,
      gender: form.gender,
      phoneNumber: form.phoneNumber,
    });
    if (!result.success) {
      setErrors(collectErrors(result.error.issues));
      return;
    }
    setErrors({});
    setStep(2);
  }

  function submit() {
    const health = {
      bloodGroup: form.bloodGroup,
      allergies: parseList(form.allergies),
      existingConditions: parseList(form.existingConditions),
      currentMedications: parseList(form.currentMedications),
      emergencyContact: form.emergencyContact,
      medicalNotes: form.medicalNotes,
    };
    const result = healthInfoSchema.safeParse(health);
    if (!result.success) {
      setErrors(collectErrors(result.error.issues));
      return;
    }
    setErrors({});
    setSubmitError(null);

    startTransition(async () => {
      const response = await completeOnboardingAction({
        fullName: form.fullName,
        dateOfBirth: form.dateOfBirth,
        gender: form.gender,
        phoneNumber: form.phoneNumber,
        ...health,
      });
      if (!response.ok) {
        setSubmitError(response.error);
        return;
      }
      setStep(3);
    });
  }

  return (
    <div className="mx-auto max-w-2xl">
      {/* Progress rail */}
      <ol className="mb-8 flex items-center gap-3" aria-label="Onboarding progress">
        {STEPS.map((s, i) => (
          <li key={s.n} className="flex flex-1 items-center gap-3">
            <span
              className="step-dot"
              data-state={step === s.n ? "active" : step > s.n ? "done" : "todo"}
              aria-current={step === s.n ? "step" : undefined}
            >
              {step > s.n ? "✓" : s.n}
            </span>
            <span
              className={`hidden text-[13px] sm:block ${
                step === s.n ? "font-semibold text-ink" : "text-muted"
              }`}
            >
              {s.label}
            </span>
            {i < STEPS.length - 1 && <span className="h-px flex-1 bg-rule-strong" />}
          </li>
        ))}
      </ol>

      {step === 1 && (
        <Card>
          <div className="border-b border-rule px-6 py-5">
            <p className="eyebrow">Step 1 of 3</p>
            <h1 className="mt-1 text-[21px] font-semibold">Personal information</h1>
            <p className="mt-1.5 text-[14px] text-ink-soft">
              This identifies your record. Use the name your clinicians would recognize.
            </p>
          </div>

          <div className="space-y-5 px-6 py-6">
            <Field label="Full name" htmlFor="fullName" required error={errors.fullName}>
              <Input
                id="fullName"
                value={form.fullName}
                onChange={set("fullName")}
                autoComplete="name"
                aria-invalid={Boolean(errors.fullName)}
              />
            </Field>

            <div className="grid gap-5 sm:grid-cols-2">
              <Field
                label="Date of birth"
                htmlFor="dateOfBirth"
                required
                error={errors.dateOfBirth}
              >
                <Input
                  id="dateOfBirth"
                  type="date"
                  className="mono"
                  value={form.dateOfBirth}
                  onChange={set("dateOfBirth")}
                  max={new Date().toISOString().slice(0, 10)}
                  aria-invalid={Boolean(errors.dateOfBirth)}
                />
              </Field>

              <Field label="Gender" htmlFor="gender" required error={errors.gender}>
                <Select
                  id="gender"
                  value={form.gender}
                  onChange={set("gender")}
                  aria-invalid={Boolean(errors.gender)}
                >
                  <option value="">Select…</option>
                  {GENDER_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>

            <Field
              label="Phone number"
              htmlFor="phoneNumber"
              required
              error={errors.phoneNumber}
              hint="Used to reach you about your record. Never shared with advertisers."
            >
              <Input
                id="phoneNumber"
                type="tel"
                value={form.phoneNumber}
                onChange={set("phoneNumber")}
                autoComplete="tel"
                placeholder="+91 98765 43210"
                aria-invalid={Boolean(errors.phoneNumber)}
              />
            </Field>
          </div>

          <div className="flex justify-end border-t border-rule px-6 py-4">
            <Button onClick={goToStepTwo}>Continue</Button>
          </div>
        </Card>
      )}

      {step === 2 && (
        <Card>
          <div className="border-b border-rule px-6 py-5">
            <p className="eyebrow">Step 2 of 3</p>
            <h1 className="mt-1 text-[21px] font-semibold">Basic health information</h1>
            <p className="mt-1.5 text-[14px] text-ink-soft">
              Enter what you know. You can update any of this later — leave a field blank rather
              than guessing.
            </p>
          </div>

          <div className="space-y-5 px-6 py-6">
            <Field label="Blood group" htmlFor="bloodGroup" required error={errors.bloodGroup}>
              <Select
                id="bloodGroup"
                className="mono"
                value={form.bloodGroup}
                onChange={set("bloodGroup")}
                aria-invalid={Boolean(errors.bloodGroup)}
              >
                <option value="">Select…</option>
                {BLOOD_GROUP_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </Field>

            <Field
              label="Allergies"
              htmlFor="allergies"
              hint="Separate with commas. Medicines, foods or materials."
            >
              <TextArea
                id="allergies"
                value={form.allergies}
                onChange={set("allergies")}
                placeholder="Penicillin, Peanuts"
              />
            </Field>

            <Field
              label="Existing conditions"
              htmlFor="existingConditions"
              hint="Anything you are currently managing or being treated for."
            >
              <TextArea
                id="existingConditions"
                value={form.existingConditions}
                onChange={set("existingConditions")}
                placeholder="Type 2 diabetes, Asthma"
              />
            </Field>

            <Field
              label="Current medications"
              htmlFor="currentMedications"
              hint="Include the dose if you know it."
            >
              <TextArea
                id="currentMedications"
                value={form.currentMedications}
                onChange={set("currentMedications")}
                placeholder="Metformin 500 mg, Salbutamol inhaler"
              />
            </Field>

            <Field label="Emergency contact" htmlFor="emergencyContact">
              <Input
                id="emergencyContact"
                value={form.emergencyContact}
                onChange={set("emergencyContact")}
                placeholder="Priya Krishnan (sister) · +91 98111 22334"
              />
            </Field>

            <Field
              label="Anything else your clinicians should know"
              htmlFor="medicalNotes"
            >
              <TextArea
                id="medicalNotes"
                value={form.medicalNotes}
                onChange={set("medicalNotes")}
                placeholder="Previous surgeries, family history, or anything you'd want mentioned."
              />
            </Field>

            {submitError && <Callout tone="critical">{submitError}</Callout>}
          </div>

          <div className="flex justify-between border-t border-rule px-6 py-4">
            <Button variant="secondary" onClick={() => setStep(1)} disabled={pending}>
              Back
            </Button>
            <Button onClick={submit} disabled={pending}>
              {pending ? "Creating your profile…" : "Create my health profile"}
            </Button>
          </div>
        </Card>
      )}

      {step === 3 && (
        <Card>
          <div className="px-6 py-10 text-center">
            <span
              className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-positive-wash text-[20px] text-positive"
              aria-hidden="true"
            >
              ✓
            </span>
            <h1 className="mt-5 text-[22px] font-semibold">
              Your AVERIS Health Profile has been successfully created.
            </h1>
            <p className="mx-auto mt-3 max-w-md text-[14.5px] leading-relaxed text-ink-soft">
              Your health identity has been issued. You can review it, and update any detail,
              from your dashboard at any time.
            </p>
            <div className="mt-8">
              <Button onClick={() => router.push("/dashboard")}>Go to my dashboard</Button>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}
