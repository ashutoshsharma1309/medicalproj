"use client";

import { useActionState, useMemo, useState } from "react";
import { useFormStatus } from "react-dom";
import { signUpAction, type AuthFormState } from "../actions";
import { Button, Field, Input, Callout } from "@/components/ui";

function passwordStrength(pw: string): { score: 0 | 1 | 2 | 3; label: string } {
  if (!pw) return { score: 0, label: "" };
  let score = 0;
  if (pw.length >= 8) score++;
  if (/[A-Za-z]/.test(pw) && /[0-9]/.test(pw)) score++;
  if (pw.length >= 12 && /[^A-Za-z0-9]/.test(pw)) score++;
  const labels = [
    "Too short — use at least 8 characters",
    "Weak — add both letters and numbers",
    "Good",
    "Strong",
  ] as const;
  return { score: score as 0 | 1 | 2 | 3, label: labels[score] };
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" className="w-full" disabled={pending}>
      {pending ? "Creating your account…" : "Create account"}
    </Button>
  );
}

export function SignupForm() {
  const [state, formAction] = useActionState<AuthFormState, FormData>(signUpAction, {
    error: null,
  });
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");

  const strength = useMemo(() => passwordStrength(password), [password]);
  const mismatch = confirm.length > 0 && confirm !== password;

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <Field label="Full name" htmlFor="fullName" required>
        <Input
          id="fullName"
          name="fullName"
          autoComplete="name"
          placeholder="e.g. Ananya Krishnan"
          required
          minLength={2}
        />
      </Field>

      <Field label="Email address" htmlFor="email" required>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          placeholder="you@example.com"
          required
        />
      </Field>

      <Field
        label="Password"
        htmlFor="password"
        required
        hint={strength.label || "At least 8 characters, including a letter and a number."}
      >
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          minLength={8}
        />
        {password.length > 0 && (
          <div className="mt-2 flex gap-1" aria-hidden="true">
            {[1, 2, 3].map((step) => (
              <span
                key={step}
                className="h-1 flex-1 rounded-full transition-colors"
                style={{
                  background:
                    strength.score >= step
                      ? strength.score === 1
                        ? "var(--color-notice)"
                        : "var(--color-positive)"
                      : "var(--color-rule)",
                }}
              />
            ))}
          </div>
        )}
      </Field>

      <Field
        label="Confirm password"
        htmlFor="confirmPassword"
        required
        error={mismatch ? "Passwords do not match." : undefined}
      >
        <Input
          id="confirmPassword"
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          aria-invalid={mismatch}
          required
        />
      </Field>

      {state.error && <Callout tone="critical">{state.error}</Callout>}

      <SubmitButton />
    </form>
  );
}
