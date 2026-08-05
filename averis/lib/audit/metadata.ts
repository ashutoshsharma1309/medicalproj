/**
 * Audit metadata rules.
 *
 * Split from audit-service so it carries no `server-only` import: the
 * allowlist is the part of auditing most worth testing, and a rule that can
 * only be exercised inside a Next.js server runtime is a rule that quietly
 * stops being exercised.
 */

export type AuditAction =
  | "DOCUMENT_UPLOADED"
  | "DOCUMENT_VIEWED"
  | "DOCUMENT_DELETED"
  | "EXTRACTION_CONFIRMED"
  | "PROFILE_UPDATED"
  | "HEALTH_SUMMARY_VIEWED"
  | "RISK_PREDICTION_GENERATED"
  | "AI_QUESTION_ASKED"
  | "REPORT_EXPLAINED"
  | "SIGNED_IN"
  | "SIGNED_OUT";

export type AuditResource =
  | "DOCUMENT"
  | "PROFILE"
  | "PREDICTION"
  | "CONVERSATION"
  | "TWIN"
  | "SESSION";

/** Metadata keys that may be recorded. Anything else is dropped. */
const ALLOWED_METADATA_KEYS = new Set([
  "requestId",
  "documentType",
  "fileSize",
  "mimeType",
  "model",
  "modelVersion",
  "riskCategory",
  "durationMs",
  "chunkCount",
  "sourceCount",
  "recordCount",
  "plan",
  "outcome",
  "reason",
  "questionLength",
  "abstained",
  "guardrailTriggered",
]);

/**
 * An allowlist, not a blocklist.
 *
 * A blocklist fails open: the first time someone adds `patientNotes` to a
 * metadata payload it sails through, and the leak is discovered later by
 * reading production logs. An allowlist fails closed — the new field is
 * dropped and the entry is merely less informative than intended.
 */
export function sanitizeMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(metadata)) {
    if (!ALLOWED_METADATA_KEYS.has(key)) continue;
    if (value === null || value === undefined) continue;

    if (typeof value === "number" || typeof value === "boolean") {
      safe[key] = value;
    } else if (typeof value === "string") {
      // Even allowed string fields are bounded: `reason` is a category, not a
      // place to put a stack trace or an extraction.
      safe[key] = value.slice(0, 120);
    }
  }

  return safe;
}

