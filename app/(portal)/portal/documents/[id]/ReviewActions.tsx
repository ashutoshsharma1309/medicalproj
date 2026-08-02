"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function ReviewActions({ documentId }: { documentId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState<string[] | null>(null);

  async function confirm() {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/portal/documents/${documentId}/confirm`, { method: "POST" });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) {
      setError(data.error ?? "Could not save. Try again.");
      return;
    }
    setApplied(data.applied);
    router.refresh();
  }

  if (applied) {
    return (
      <div className="rounded-md border border-ok-line bg-ok-wash px-4 py-3 text-[13px]">
        <p className="font-semibold text-ok">Saved to your profile.</p>
        {applied.length > 0 ? (
          <ul className="mt-1 list-disc pl-4 text-muted">
            {applied.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-muted">Everything in this document was already on file — no changes were needed.</p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {error && (
        <p className="rounded-md border border-critical-line bg-critical-wash px-3 py-2 text-[13px] text-critical">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-3">
        <button className="btn btn-primary" onClick={confirm} disabled={busy}>
          {busy ? "Saving…" : "Confirm and save to my profile"}
        </button>
        <button
          className="btn btn-secondary"
          onClick={() => router.push("/portal/setup")}
          disabled={busy}
        >
          Edit manually instead
        </button>
      </div>
      <p className="text-xs leading-relaxed text-faint">
        Confirming only adds new information — it never overwrites or removes anything your
        care team has recorded.
      </p>
    </div>
  );
}
