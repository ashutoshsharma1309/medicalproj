"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

function strength(pw: string): { score: 0 | 1 | 2 | 3; label: string } {
  if (pw.length === 0) return { score: 0, label: "" };
  let s = 0;
  if (pw.length >= 8) s++;
  if (/[A-Za-z]/.test(pw) && /[0-9]/.test(pw)) s++;
  if (pw.length >= 12 && /[^A-Za-z0-9]/.test(pw)) s++;
  return (
    [
      { score: 0 as const, label: "Too short — use at least 8 characters" },
      { score: 1 as const, label: "Weak — add letters and numbers" },
      { score: 2 as const, label: "Good" },
      { score: 3 as const, label: "Strong" },
    ][s] ?? { score: 3, label: "Strong" }
  );
}

export function SignupForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const pw = useMemo(() => strength(password), [password]);
  const mismatch = confirm.length > 0 && confirm !== password;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (pw.score < 2) {
      setError("Choose a stronger password: at least 8 characters with letters and numbers.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    setBusy(true);
    const res = await fetch("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, email, password, confirmPassword: confirm }),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) {
      setError(data.error ?? "Sign up failed. Try again.");
      return;
    }
    router.push(data.redirect);
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="mt-6 space-y-4">
      <div>
        <label className="label" htmlFor="su-name">Full name</label>
        <input
          id="su-name"
          className="field"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Rahul Sharma"
          autoComplete="name"
          required
          minLength={2}
        />
      </div>
      <div>
        <label className="label" htmlFor="su-email">Email address</label>
        <input
          id="su-email"
          type="email"
          className="field"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          autoComplete="email"
          required
        />
      </div>
      <div>
        <label className="label" htmlFor="su-pw">Password</label>
        <input
          id="su-pw"
          type="password"
          className="field"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="At least 8 characters, letters and numbers"
          autoComplete="new-password"
          required
          minLength={8}
          aria-describedby="pw-strength"
        />
        {password.length > 0 && (
          <div id="pw-strength" className="mt-1.5">
            <div className="flex gap-1">
              {[1, 2, 3].map((i) => (
                <span
                  key={i}
                  className="h-1 flex-1 rounded-full"
                  style={{
                    background:
                      pw.score >= i
                        ? pw.score === 1
                          ? "var(--color-warn)"
                          : "var(--color-ok)"
                        : "var(--color-hairline)",
                  }}
                />
              ))}
            </div>
            <p className="mt-1 text-xs text-muted">{pw.label}</p>
          </div>
        )}
      </div>
      <div>
        <label className="label" htmlFor="su-confirm">Confirm password</label>
        <input
          id="su-confirm"
          type="password"
          className="field"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete="new-password"
          required
          aria-invalid={mismatch}
        />
        {mismatch && <p className="mt-1 text-xs text-critical">Passwords do not match.</p>}
      </div>

      {error && (
        <p className="rounded-md border border-critical-line bg-critical-wash px-3 py-2 text-[13px] text-critical">
          {error}
          {/already registered/i.test(error) && (
            <>
              {" "}
              <a href="/login" className="font-semibold underline">Go to sign in</a>
            </>
          )}
        </p>
      )}

      <button type="submit" className="btn btn-primary w-full justify-center" disabled={busy}>
        {busy ? "Creating your account…" : "Create account"}
      </button>
      <p className="text-xs leading-relaxed text-faint">
        Next you&rsquo;ll set up your medical profile — it takes about two minutes, and you can
        upload documents instead of typing everything.
      </p>
    </form>
  );
}
