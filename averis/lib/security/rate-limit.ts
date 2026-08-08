/**
 * Rate limiting.
 *
 * A sliding-window counter, kept deliberately simple and pure so the decision
 * logic is testable without a clock or a network.
 *
 * **What this protects.** Not the database — RLS does that. This protects the
 * expensive, externally-billed paths: OCR, model inference, embedding
 * generation. A single authenticated account looping over `/api/risk` or the
 * Ask endpoint costs real money per request, and cost is the attack surface
 * that authentication does not close.
 *
 * **Why sliding and not fixed windows.** A fixed window lets a caller send a
 * full quota at 11:59:59 and another at 12:00:00 — twice the intended rate at
 * the boundary, which is exactly when a script retrying on a schedule will
 * hit. The sliding window weights the previous window by how much of it is
 * still in view, so the boundary is not a free doubling.
 *
 * **Storage is injected.** In one process this is a Map; across several it is
 * Redis. The algorithm does not change, so the single-instance path is not a
 * different code path that only gets exercised in development.
 */

export type RateLimitRule = {
  /** Requests allowed per window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
};

export type RateLimitDecision = {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Milliseconds until the caller should retry. Zero when allowed. */
  retryAfterMs: number;
};

/**
 * Per-operation budgets.
 *
 * Set by what each call costs rather than by a single global number. Asking a
 * question runs an embedding pass plus a model call; listing documents runs a
 * query. Treating them the same would either throttle browsing or leave the
 * expensive path wide open.
 */
export const RATE_LIMITS = {
  /** Upload: OCR plus an extraction call, and storage that persists. */
  documentUpload: { limit: 10, windowMs: 60 * 60 * 1000 },
  /** Ask AVERIS: one embedding pass and one completion. */
  askQuestion: { limit: 20, windowMs: 60 * 60 * 1000 },
  /** Report explanation: a completion over a whole document. */
  explainReport: { limit: 20, windowMs: 60 * 60 * 1000 },
  /** Risk assessment: local inference, so cheap — bounded against loops. */
  riskAssessment: { limit: 60, windowMs: 60 * 60 * 1000 },
  /**
   * Care team changes. The only limit here that is not about cost.
   *
   * `invite_caregiver` reports whether an email address has an AVERIS account,
   * which is an enumeration oracle — accepted deliberately, because a patient
   * adding their daughter needs to tell a typo from someone who has not signed
   * up. Twenty an hour is generous for a real patient and useless for a script
   * working through an address list.
   */
  careTeamChange: { limit: 20, windowMs: 60 * 60 * 1000 },
  /** Report generation: a completion over a whole monitoring window. */
  healthReport: { limit: 20, windowMs: 60 * 60 * 1000 },
  /** The clinical assistant: one completion per question, per clinician. */
  careAssistant: { limit: 40, windowMs: 60 * 60 * 1000 },
} as const satisfies Record<string, RateLimitRule>;

export type RateLimitedOperation = keyof typeof RATE_LIMITS;

/** Counter storage. Two integers per key; nothing else is needed. */
export type WindowCounts = {
  /** Count in the window currently in progress. */
  current: number;
  /** Count in the window before it. */
  previous: number;
  /** Start of the current window, in epoch milliseconds. */
  windowStart: number;
};

export type CounterStore = {
  read(key: string): Promise<WindowCounts | null>;
  write(key: string, counts: WindowCounts, ttlMs: number): Promise<void>;
};

/**
 * Decides, given the stored counts and the current time.
 *
 * Pure: no clock, no storage, no I/O. Every boundary condition is testable
 * directly, which matters because the interesting bugs in rate limiting all
 * live at window edges.
 */
export function decide(
  stored: WindowCounts | null,
  rule: RateLimitRule,
  now: number,
): { decision: RateLimitDecision; next: WindowCounts } {
  const windowStart = Math.floor(now / rule.windowMs) * rule.windowMs;

  let counts: WindowCounts;

  if (!stored) {
    counts = { current: 0, previous: 0, windowStart };
  } else if (stored.windowStart === windowStart) {
    counts = { ...stored };
  } else if (stored.windowStart === windowStart - rule.windowMs) {
    // Exactly one window has elapsed: the old current becomes the previous.
    counts = { current: 0, previous: stored.current, windowStart };
  } else {
    // A gap of two or more windows means nothing recent is in view.
    counts = { current: 0, previous: 0, windowStart };
  }

  // How much of the previous window still overlaps the trailing window.
  const elapsed = now - windowStart;
  const previousWeight = Math.max(0, 1 - elapsed / rule.windowMs);
  const weighted = counts.previous * previousWeight + counts.current;

  if (weighted >= rule.limit) {
    return {
      decision: {
        allowed: false,
        limit: rule.limit,
        remaining: 0,
        // Retry when enough of the previous window has aged out. Callers get
        // a concrete number rather than being told to guess.
        retryAfterMs: Math.max(1000, rule.windowMs - elapsed),
      },
      next: counts,
    };
  }

  const next = { ...counts, current: counts.current + 1 };

  return {
    decision: {
      allowed: true,
      limit: rule.limit,
      remaining: Math.max(0, Math.floor(rule.limit - weighted - 1)),
      retryAfterMs: 0,
    },
    next,
  };
}

/** Namespaced so two operations never share a counter. */
export function rateLimitKey(operation: RateLimitedOperation, subject: string): string {
  return `ratelimit:${operation}:${subject}`;
}

export async function checkRateLimit(
  store: CounterStore,
  operation: RateLimitedOperation,
  subject: string,
  now = Date.now(),
): Promise<RateLimitDecision> {
  const rule = RATE_LIMITS[operation];
  const key = rateLimitKey(operation, subject);

  const stored = await store.read(key);
  const { decision, next } = decide(stored, rule, now);

  if (decision.allowed) {
    // Two windows must outlive the current one, or the sliding calculation
    // loses the history it depends on.
    await store.write(key, next, rule.windowMs * 2);
  }

  return decision;
}

/** In-process store. Correct for one instance; see the module note. */
export function memoryCounterStore(): CounterStore {
  const entries = new Map<string, { counts: WindowCounts; expiresAt: number }>();

  return {
    async read(key) {
      const entry = entries.get(key);
      if (!entry) return null;
      if (entry.expiresAt <= Date.now()) {
        entries.delete(key);
        return null;
      }
      return entry.counts;
    },
    async write(key, counts, ttlMs) {
      entries.set(key, { counts, expiresAt: Date.now() + ttlMs });

      // Bounded so a burst of distinct subjects cannot grow the map forever.
      if (entries.size > 10_000) {
        const now = Date.now();
        for (const [k, v] of entries) if (v.expiresAt <= now) entries.delete(k);
      }
    },
  };
}
