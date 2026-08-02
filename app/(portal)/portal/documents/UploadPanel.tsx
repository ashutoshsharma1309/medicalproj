"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

const ACCEPT = ".pdf,.jpg,.jpeg,.png,.txt,application/pdf,image/jpeg,image/png,text/plain";
const MAX_MB = 8;

export function UploadPanel() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function handleFiles(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    setError(null);
    setNotice(null);

    if (file.size > MAX_MB * 1024 * 1024) {
      setError(`"${file.name}" is larger than ${MAX_MB} MB. Compress or re-scan it and try again.`);
      return;
    }
    setBusy(true);
    const form = new FormData();
    form.append("file", file);
    const res = await fetch("/api/portal/documents", { method: "POST", body: form });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) {
      setError(data.error ?? "Upload failed. Try again.");
      return;
    }
    if (data.status === "EXTRACTED") {
      router.push(`/portal/documents/${data.documentId}`);
    } else {
      setNotice(
        data.message ??
          "Your document was stored. Extraction was not possible right now — you can still view it anytime.",
      );
      router.refresh();
    }
  }

  return (
    <section
      className={`card border-2 border-dashed px-6 py-10 text-center transition-colors ${
        dragging ? "border-scrub bg-scrub-wash" : "border-hairline-strong"
      }`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        handleFiles(e.dataTransfer.files);
      }}
      aria-label="Upload medical documents"
    >
      <svg viewBox="0 0 24 24" className="mx-auto h-8 w-8 text-scrub" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M7 3h7l5 5v13H7z" />
        <path d="M14 3v5h5" />
        <path d="M12 17v-6M9.5 13.5 12 11l2.5 2.5" />
      </svg>
      <h2 className="mt-3 text-[15px] font-semibold">Upload your medical documents</h2>
      <p className="mx-auto mt-1 max-w-md text-[13px] leading-relaxed text-muted">
        Drag and drop a prescription, blood report, discharge summary or lab report here —
        or browse your files.
      </p>
      <div className="mt-4">
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => inputRef.current?.click()}
          disabled={busy}
        >
          {busy ? "Uploading & reading…" : "Choose a file"}
        </button>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          className="hidden"
          onChange={(e) => handleFiles(e.target.files)}
        />
      </div>
      <p className="mt-3 font-mono text-[10.5px] uppercase tracking-wider text-faint">
        Supported: PDF · JPG · PNG · TXT — up to {MAX_MB} MB
      </p>

      {busy && (
        <p className="mx-auto mt-4 max-w-md rounded-md border border-info-line bg-info-wash px-4 py-2.5 text-[13px] text-info">
          Reading your document… this usually takes a few seconds.
        </p>
      )}
      {error && (
        <p className="mx-auto mt-4 max-w-md rounded-md border border-critical-line bg-critical-wash px-4 py-2.5 text-[13px] text-critical">
          {error}
        </p>
      )}
      {notice && (
        <p className="mx-auto mt-4 max-w-md rounded-md border border-warn-line bg-warn-wash px-4 py-2.5 text-left text-[13px]">
          {notice}
        </p>
      )}
    </section>
  );
}
