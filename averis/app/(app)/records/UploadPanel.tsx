"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useFormStatus } from "react-dom";
import { Button, Callout, Card } from "@/components/ui";
import { DOCUMENT_CATEGORIES } from "@/lib/services/documents/labels";
import { uploadMedicalDocumentAction, type UploadState } from "./actions";

const MAX_MB = 15;
const ACCEPT = ".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png";

function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function SubmitButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={disabled || pending}>
      {pending ? "Reading your document…" : "Upload and read document"}
    </Button>
  );
}

/** Shown while the server action runs, so the wait is explained rather than blank. */
function ProcessingNotice() {
  const { pending } = useFormStatus();
  if (!pending) return null;
  return (
    <Callout tone="brand" title="AVERIS is reading your document">
      Extracting text, then identifying conditions, medications, allergies and test
      results. This usually takes a few seconds — you&rsquo;ll review everything before
      anything is saved.
    </Callout>
  );
}

export function UploadPanel() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [state, formAction] = useActionState<UploadState, FormData>(
    uploadMedicalDocumentAction,
    { error: null },
  );

  const [category, setCategory] = useState<string>("BLOOD_REPORT");
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [clientError, setClientError] = useState<string | null>(null);

  function acceptFile(candidate: File | undefined) {
    if (!candidate) return;
    setClientError(null);

    if (candidate.size > MAX_MB * 1024 * 1024) {
      setClientError(`"${candidate.name}" is larger than ${MAX_MB} MB.`);
      setFile(null);
      return;
    }
    const allowed = ["application/pdf", "image/jpeg", "image/png"];
    if (!allowed.includes(candidate.type)) {
      setClientError("Upload a PDF, JPG or PNG document.");
      setFile(null);
      return;
    }
    setFile(candidate);
  }

  // Navigation is a side effect, so it belongs in an effect rather than in
  // render — calling router.push() during render double-fires under Strict
  // Mode and warns about updating another component while rendering.
  useEffect(() => {
    if (state.status === "PENDING_REVIEW" && state.documentId) {
      router.push(`/records/${state.documentId}/review`);
    }
  }, [state.status, state.documentId, router]);

  return (
    <Card>
      <div className="border-b border-rule px-6 py-5">
        <p className="eyebrow">Add to your records</p>
        <h2 className="mt-1 text-[19px] font-semibold">Upload a medical document</h2>
        <p className="mt-1.5 max-w-2xl text-[14px] leading-relaxed text-ink-soft">
          AVERIS reads the document and proposes what to add to your health profile. You
          review and confirm every item — nothing is saved automatically.
        </p>
      </div>

      <form action={formAction} className="px-6 py-6">
        <input type="hidden" name="documentType" value={category} />

        {/* Step 1 — category */}
        <fieldset>
          <legend className="eyebrow mb-3">Step 1 · What kind of document is this?</legend>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {DOCUMENT_CATEGORIES.map((option) => {
              const selected = category === option.value;
              return (
                <label
                  key={option.value}
                  className={`cursor-pointer rounded-lg border px-3.5 py-3 transition-colors ${
                    selected
                      ? "border-brand bg-wash"
                      : "border-rule-strong bg-surface hover:border-brand-mid"
                  }`}
                >
                  <span className="flex items-start gap-2.5">
                    <input
                      type="radio"
                      name="category"
                      value={option.value}
                      checked={selected}
                      onChange={() => setCategory(option.value)}
                      className="mt-1 accent-[var(--color-brand)]"
                    />
                    <span>
                      <span className="block text-[14px] font-semibold">{option.label}</span>
                      <span className="mt-0.5 block text-[12.5px] leading-snug text-muted">
                        {option.hint}
                      </span>
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>

        {/* Step 2 — file */}
        <div className="mt-7">
          <p className="eyebrow mb-3">Step 2 · Choose the file</p>

          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              const dropped = e.dataTransfer.files?.[0];
              acceptFile(dropped);
              if (dropped && inputRef.current) {
                const transfer = new DataTransfer();
                transfer.items.add(dropped);
                inputRef.current.files = transfer.files;
              }
            }}
            className={`rounded-lg border-2 border-dashed px-6 py-9 text-center transition-colors ${
              dragging ? "border-brand bg-wash" : "border-rule-strong bg-paper"
            }`}
          >
            <svg
              viewBox="0 0 24 24"
              className="mx-auto h-7 w-7 text-brand"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M7 3h7l5 5v13H7z" />
              <path d="M14 3v5h5" />
              <path d="M12 17v-6M9.5 13.5 12 11l2.5 2.5" />
            </svg>
            <p className="mt-3 text-[14.5px] font-medium">
              Drag your document here, or{" "}
              <button
                type="button"
                onClick={() => inputRef.current?.click()}
                className="text-brand underline underline-offset-2"
              >
                browse your files
              </button>
            </p>
            <p className="mt-1.5 font-mono text-[10.5px] uppercase tracking-[0.14em] text-muted">
              PDF · JPG · PNG — up to {MAX_MB} MB
            </p>

            <input
              ref={inputRef}
              type="file"
              name="file"
              accept={ACCEPT}
              className="sr-only"
              onChange={(e) => acceptFile(e.target.files?.[0])}
            />
          </div>

          {file && (
            <div className="mt-3 flex items-center justify-between gap-4 rounded-lg border border-rule bg-surface px-4 py-3">
              <span className="min-w-0">
                <span className="block truncate text-[14px] font-medium">{file.name}</span>
                <span className="mono text-[12px] text-muted">
                  {formatSize(file.size)} · {file.type.replace("application/", "").toUpperCase()}
                </span>
              </span>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  setFile(null);
                  if (inputRef.current) inputRef.current.value = "";
                }}
              >
                Remove
              </button>
            </div>
          )}
        </div>

        <div className="mt-6 space-y-4">
          <ProcessingNotice />
          {clientError && <Callout tone="critical">{clientError}</Callout>}
          {state.error && (
            <Callout tone="critical" title="We couldn't read that document">
              {state.error}
            </Callout>
          )}
          <SubmitButton disabled={!file} />
        </div>
      </form>
    </Card>
  );
}
