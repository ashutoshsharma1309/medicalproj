"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useCareBridgeAssessment } from "@/lib/carebridge/assessment-context";
import { LANGUAGE_OPTIONS } from "@/lib/carebridge/mock/assessment";
import { PrimaryButton } from "@/components/carebridge/PrimaryButton";
import { LoadingState } from "@/components/carebridge/LoadingState";
import { IconChevronRight, IconInfo } from "@/components/carebridge/icons";

export default function AssessmentSetupPage() {
  const router = useRouter();
  const { setup, updateSetup } = useCareBridgeAssessment();
  const [age, setAge] = useState(setup.age);
  const [language, setLanguage] = useState(setup.language || "English");
  const [existingConditions, setExistingConditions] = useState(setup.existingConditions);
  const [currentMedications, setCurrentMedications] = useState(setup.currentMedications);
  const [error, setError] = useState<string | null>(null);
  const [showWhy, setShowWhy] = useState(false);
  const [saving, setSaving] = useState(false);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const ageNum = Number(age);
    if (!age.trim() || !Number.isFinite(ageNum) || ageNum <= 0 || ageNum > 120) {
      setError("Enter a valid age between 1 and 120.");
      return;
    }
    setError(null);
    updateSetup({ age: age.trim(), language, existingConditions, currentMedications });

    // Simulated save — Phase 3 replaces this with a real API call.
    setSaving(true);
    window.setTimeout(() => router.push("/assessment/interview"), 500);
  }

  if (saving) {
    return <LoadingState message="Saving your information…" />;
  }

  return (
    <div className="mx-auto max-w-lg">
      <p className="cb-status cb-status-neutral">Step 1 of 3</p>
      <h1 className="mt-3 text-[24px] font-semibold text-cb-ink">A few basics first</h1>
      <p className="mt-1.5 text-[14px] text-cb-muted">
        This helps CareBridge ask more relevant questions. We only ask what's needed.
      </p>

      <form onSubmit={handleSubmit} className="cb-card mt-6 space-y-5 p-5 sm:p-6" noValidate>
        <div>
          <label htmlFor="age" className="cb-label">
            Age
          </label>
          <input
            id="age"
            className="cb-field"
            inputMode="numeric"
            value={age}
            onChange={(e) => setAge(e.target.value)}
            placeholder="e.g. 21"
            aria-describedby={error ? "age-error" : undefined}
            aria-invalid={Boolean(error)}
            required
          />
          {error && (
            <p id="age-error" className="cb-hint text-cb-danger">
              {error}
            </p>
          )}
        </div>

        <div>
          <label htmlFor="language" className="cb-label">
            Preferred language
          </label>
          <select
            id="language"
            className="cb-field"
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
          >
            {LANGUAGE_OPTIONS.map((lang) => (
              <option key={lang} value={lang}>
                {lang}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="conditions" className="cb-label">
            Existing conditions <span className="font-normal text-cb-faint">(optional)</span>
          </label>
          <input
            id="conditions"
            className="cb-field"
            value={existingConditions}
            onChange={(e) => setExistingConditions(e.target.value)}
            placeholder="e.g. asthma, diabetes"
          />
        </div>

        <div>
          <label htmlFor="medications" className="cb-label">
            Current medications <span className="font-normal text-cb-faint">(optional)</span>
          </label>
          <input
            id="medications"
            className="cb-field"
            value={currentMedications}
            onChange={(e) => setCurrentMedications(e.target.value)}
            placeholder="e.g. metformin 500mg"
          />
        </div>

        <div>
          <button
            type="button"
            className="flex items-center gap-1.5 text-[12.5px] font-semibold text-cb-primary"
            aria-expanded={showWhy}
            aria-controls="why-we-ask"
            onClick={() => setShowWhy((v) => !v)}
          >
            <IconInfo className="h-4 w-4" />
            Why do we ask this?
          </button>
          {showWhy && (
            <p id="why-we-ask" className="cb-hint mt-2">
              Your age and history help CareBridge ask more relevant follow-up questions and notice
              anything that might need prompt attention. You can leave the optional fields blank.
            </p>
          )}
        </div>

        <PrimaryButton type="submit" className="cb-btn-block" icon={<IconChevronRight />}>
          Continue
        </PrimaryButton>
      </form>
    </div>
  );
}
