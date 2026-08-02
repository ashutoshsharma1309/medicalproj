"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const DEMO_ACCOUNTS = [
  { label: "Physician", email: "dr.reyes@meridian.health", desc: "Full clinical workspace" },
  { label: "Administrator", email: "admin@meridian.health", desc: "Analytics, users, audit trail" },
  { label: "Patient", email: "eleanor.vance@example.com", desc: "Personal health portal" },
];

export function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e?: React.FormEvent, overrideEmail?: string) {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: overrideEmail ?? email,
        password: overrideEmail ? "demo1234" : password,
        remember,
      }),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) {
      setError(data.error ?? "Sign in failed.");
      return;
    }
    router.push(data.redirect);
    router.refresh();
  }

  return (
    <div className="w-full max-w-sm">
      <h2 className="text-xl font-semibold">Sign in</h2>
      <p className="mt-1 text-[13px] text-muted">Use your organization credentials.</p>

      <form onSubmit={submit} className="mt-6 space-y-4">
        <div>
          <label className="label" htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            className="field"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="name@hospital.org"
            autoComplete="username"
            required
          />
        </div>
        <div>
          <label className="label" htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            className="field"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            autoComplete="current-password"
            required
          />
        </div>
        <label className="flex items-center gap-2 text-[13px] text-muted">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
            className="h-3.5 w-3.5 accent-[var(--color-scrub)]"
          />
          Keep me signed in for 30 days
        </label>
        {error && (
          <p className="rounded-md border border-critical-line bg-critical-wash px-3 py-2 text-[13px] text-critical">
            {error}
          </p>
        )}
        <button type="submit" className="btn btn-primary w-full justify-center" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
        <p className="text-[13px] text-muted">
          New patient?{" "}
          <a href="/signup" className="font-medium text-scrub hover:underline">
            Create an account
          </a>
        </p>
      </form>

      <div className="mt-8">
        <div className="eyebrow mb-2">Evaluation accounts · password “demo1234”</div>
        <div className="space-y-2">
          {DEMO_ACCOUNTS.map((a) => (
            <button
              key={a.email}
              type="button"
              disabled={busy}
              onClick={() => submit(undefined, a.email)}
              className="card flex w-full items-center justify-between px-4 py-3 text-left transition-colors hover:border-scrub"
            >
              <div>
                <div className="text-[13px] font-semibold">{a.label}</div>
                <div className="text-xs text-muted">{a.desc}</div>
              </div>
              <span className="font-mono text-[11px] text-faint">{a.email}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
