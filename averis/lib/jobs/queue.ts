/**
 * Background job scheduling.
 *
 * Pure: the retry and backoff arithmetic lives here so it can be tested
 * without a database, a worker, or a clock.
 *
 * **Why a table and not a broker.** AVERIS already has Postgres, and Postgres
 * with `FOR UPDATE SKIP LOCKED` gives exactly the guarantee this workload
 * needs: a job is claimed by one worker, and a worker that dies mid-job
 * releases its claim when its transaction dies with it. Adding SQS or Redis
 * Streams would mean a second durable store to operate, back up and reason
 * about — and a job whose state can disagree with the document row it refers
 * to, because they would live in different systems and there would be no
 * transaction spanning them.
 *
 * The trade is real: this does not scale to millions of jobs a minute. At that
 * point a broker earns its complexity. Below it, it does not.
 */

export type JobStatus = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "DEAD";

export type JobRecord = {
  id: string;
  documentId: string;
  patientId: string;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  runAfter: string;
  lastError: string | null;
};

/** Base for exponential backoff. */
const BASE_DELAY_MS = 30_000;

/** Ceiling, so a repeatedly failing job still retries within a working day. */
const MAX_DELAY_MS = 30 * 60 * 1000;

/**
 * Delay before the next attempt.
 *
 * Exponential with jitter. The jitter is not decoration: an outage in the OCR
 * or model provider fails every in-flight job at nearly the same instant, and
 * without jitter every one of them retries at the same instant too — a
 * thundering herd that arrives precisely when the dependency is least able to
 * absorb it.
 */
export function backoffMs(attempt: number, random = Math.random): number {
  const exponential = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1));
  // Full jitter: uniform over [0, exponential]. Spreads retries widest for a
  // given mean delay.
  return Math.floor(random() * exponential);
}

export type FailureOutcome = {
  status: Extract<JobStatus, "QUEUED" | "DEAD">;
  runAfterMs: number;
  /** True when attempts are exhausted and a human should look. */
  exhausted: boolean;
};

/**
 * What happens to a job that just failed.
 *
 * A job that exhausts its attempts becomes DEAD rather than being deleted or
 * retried forever. Deleting it loses the evidence of why processing failed for
 * a patient who is still waiting; retrying forever burns money on a document
 * that will never parse.
 */
export function onFailure(
  attempts: number,
  maxAttempts: number,
  random = Math.random,
): FailureOutcome {
  if (attempts >= maxAttempts) {
    return { status: "DEAD", runAfterMs: 0, exhausted: true };
  }
  return { status: "QUEUED", runAfterMs: backoffMs(attempts, random), exhausted: false };
}

/**
 * Whether a failure is worth retrying at all.
 *
 * A corrupt PDF will not parse on the third attempt any more than the first,
 * and retrying it wastes an OCR call and delays the patient being told it
 * failed. Transient failures — network, rate limits, provider 5xx — are
 * exactly what retries exist for.
 */
export function isRetryable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);

  const permanent = [
    /password[- ]protected/i,
    /not a valid (?:pdf|image)/i,
    /unsupported (?:file|mime) type/i,
    /file too large/i,
    /did not contain enough readable text/i,
    /not found/i,
  ];
  if (permanent.some((pattern) => pattern.test(message))) return false;

  const transient = [
    /timeout|timed out/i,
    /rate limit|429/i,
    /50\d\b/,
    /ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up/i,
    /temporarily unavailable/i,
    /fetch failed/i,
  ];
  if (transient.some((pattern) => pattern.test(message))) return true;

  // Unknown failures get one more chance rather than being abandoned: an
  // unrecognised transient error is more likely than an unrecognised permanent
  // one, and the attempt cap bounds the cost of guessing wrong.
  return true;
}

/** ISO timestamp for the next attempt. */
export function nextRunAt(now: Date, delayMs: number): string {
  return new Date(now.getTime() + delayMs).toISOString();
}

/** A DEAD job's message, written for the patient rather than for a log. */
export function deadLetterMessage(lastError: string | null): string {
  return (
    "AVERIS could not read this document after several attempts. " +
    "You can try uploading a clearer scan, or add the details manually. " +
    (lastError ? `The last error was: ${lastError.slice(0, 200)}` : "")
  ).trim();
}
