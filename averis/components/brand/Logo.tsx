import Link from "next/link";

/**
 * AVERIS mark — a meridian arc crossed by a vertical axis, enclosed.
 * Reads as a seal/stamp, consistent with the "issued identity" direction.
 */
export function LogoMark({ className = "h-7 w-7" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <circle cx="16" cy="16" r="14.5" fill="none" stroke="currentColor" strokeWidth="1.3" opacity="0.45" />
      <circle cx="16" cy="16" r="10" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M16 2v28" stroke="currentColor" strokeWidth="1.3" />
      <path d="M6 16c3.4-3.6 16.6-3.6 20 0" fill="none" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

export function Wordmark({
  tagline = "Health Identity",
  tone = "dark",
  href = "/",
}: {
  tagline?: string | null;
  tone?: "dark" | "light";
  href?: string | null;
}) {
  const content = (
    <span className="flex items-center gap-2.5">
      <LogoMark className={tone === "light" ? "h-7 w-7 text-brass-soft" : "h-7 w-7 text-brand"} />
      <span className="leading-tight">
        <span
          className={`block font-display text-[17px] font-700 tracking-[0.16em] ${
            tone === "light" ? "text-field-bright" : "text-ink"
          }`}
          style={{ fontWeight: 700 }}
        >
          AVERIS
        </span>
        {tagline && (
          <span
            className={`block whitespace-nowrap font-mono text-[9px] uppercase tracking-[0.22em] ${
              tone === "light" ? "text-field-text" : "text-muted"
            }`}
          >
            {tagline}
          </span>
        )}
      </span>
    </span>
  );

  if (!href) return content;
  return (
    <Link href={href} aria-label="AVERIS home">
      {content}
    </Link>
  );
}
