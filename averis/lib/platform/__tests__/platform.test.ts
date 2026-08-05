import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildEvent, redact } from "../../observability/logger";
import { sanitizeMetadata } from "../../audit/metadata";
import {
  decide,
  memoryCounterStore,
  checkRateLimit,
  rateLimitKey,
  RATE_LIMITS,
} from "../../security/rate-limit";
import {
  assertSafeKey,
  cached,
  digest,
  memoryDriver,
  patientKey,
  setCacheDriver,
  sharedKey,
} from "../../cache/cache";
import {
  backoffMs,
  deadLetterMessage,
  isRetryable,
  nextRunAt,
  onFailure,
} from "../../jobs/queue";
import {
  checkDocumentQuota,
  checkQuestionQuota,
  dayStart,
  effectivePlan,
  hasFeature,
  limitsFor,
  monthStart,
  PLANS,
} from "../../plans/limits";

/* ------------------------------------------------------------- logging */

describe("log redaction", () => {
  it("redacts the fields most likely to carry health information", () => {
    const safe = redact({
      documentId: "abc",
      extractedText: "HbA1c 8.2%",
      diagnosis: "Type 2 Diabetes",
      email: "a@example.com",
      question: "what does my result mean",
    });

    assert.equal(safe.documentId, "abc");
    for (const key of ["extractedText", "diagnosis", "email", "question"]) {
      assert.equal(safe[key], "[redacted]", `${key} was not redacted`);
    }
  });

  it("redacts case- and underscore-insensitively", () => {
    const safe = redact({ Patient_Email: "x", FULLNAME: "y", extracted_text: "z" });
    for (const value of Object.values(safe)) assert.equal(value, "[redacted]");
  });

  it("redacts nested fields, not just top-level ones", () => {
    const safe = redact({ payload: { documentId: "ok", medication: "Metformin" } });
    const payload = safe.payload as Record<string, unknown>;
    assert.equal(payload.documentId, "ok");
    assert.equal(payload.medication, "[redacted]");
  });

  it("truncates long free text even under an allowed key", () => {
    const safe = redact({ reason: "x".repeat(500) });
    assert.ok(String(safe.reason).length < 260);
    assert.match(String(safe.reason), /\[truncated\]$/);
  });

  it("collapses deep objects rather than serialising a whole row", () => {
    const safe = redact({ a: { b: { c: { d: { e: "deep" } } } } });
    assert.match(JSON.stringify(safe), /\[deep\]/);
  });

  it("summarises long arrays instead of logging every element", () => {
    const safe = redact({ ids: Array.from({ length: 50 }, (_, i) => i) });
    const ids = safe.ids as { length: number; sample: unknown[] };
    assert.equal(ids.length, 50);
    assert.equal(ids.sample.length, 3);
  });

  it("keeps an error's name and message but nothing else", () => {
    const error = new Error("provider timed out");
    (error as unknown as Record<string, unknown>).apiKey = "gsk_secret";
    const safe = redact({ error });
    assert.deepEqual(safe.error, { name: "Error", message: "provider timed out" });
  });

  it("emits a flat JSON-serialisable event", () => {
    const event = buildEvent("warn", "something happened", { documentId: "d1" }, "2026-08-05T00:00:00Z");
    assert.equal(event.level, "warn");
    assert.equal(event.msg, "something happened");
    assert.equal(event.time, "2026-08-05T00:00:00Z");
    assert.doesNotThrow(() => JSON.stringify(event));
  });
});

/* --------------------------------------------------------------- audit */

describe("audit metadata", () => {
  it("keeps allowed keys and drops everything else", () => {
    const safe = sanitizeMetadata({
      documentType: "BLOOD_REPORT",
      fileSize: 1024,
      // Not on the allowlist — the exact shape of leak this guards against.
      patientNotes: "HbA1c 8.2, discuss with endocrinologist",
      extractedText: "…",
    });

    assert.deepEqual(safe, { documentType: "BLOOD_REPORT", fileSize: 1024 });
  });

  it("fails closed on an unrecognised key", () => {
    // A blocklist would let this through and the leak would be found later by
    // reading production logs.
    assert.deepEqual(sanitizeMetadata({ somethingNewAndSensitive: "value" }), {});
  });

  it("bounds allowed string values", () => {
    const safe = sanitizeMetadata({ reason: "x".repeat(500) });
    assert.ok(String(safe.reason).length <= 120);
  });

  it("drops nulls and non-scalars", () => {
    assert.deepEqual(
      sanitizeMetadata({ outcome: null, plan: { nested: true }, fileSize: 5 }),
      { fileSize: 5 },
    );
  });
});

/* --------------------------------------------------------- rate limits */

describe("rate limiting", () => {
  const rule = { limit: 3, windowMs: 60_000 };

  it("allows up to the limit and then denies", () => {
    let counts = null as Parameters<typeof decide>[0];
    for (let i = 0; i < 3; i += 1) {
      const { decision, next } = decide(counts, rule, 1_000_000);
      assert.equal(decision.allowed, true, `request ${i + 1} should be allowed`);
      counts = next;
    }
    assert.equal(decide(counts, rule, 1_000_000).decision.allowed, false);
  });

  it("does not allow a second full quota across a window boundary", () => {
    // The fixed-window bug this design exists to avoid: spend a full quota at
    // 11:59:59 and another at 12:00:00, and a caller gets twice the intended
    // rate at exactly the moment a scheduled retry fires.
    //
    // A sliding window still permits a small overshoot right at the boundary —
    // with a full previous window the weighted count is limit*(1-e), a hair
    // under the limit. What it must not permit is a whole second quota, so
    // that is what is asserted.
    let counts = { current: rule.limit, previous: 0, windowStart: 0 };
    let allowed = 0;

    for (let i = 0; i < rule.limit; i += 1) {
      const { decision, next } = decide(counts, rule, rule.windowMs + 1);
      if (decision.allowed) allowed += 1;
      counts = next;
    }

    assert.ok(
      allowed < rule.limit,
      `a full second quota (${allowed}/${rule.limit}) was granted at the boundary`,
    );
  });

  it("lets the previous window age out gradually", () => {
    const spent = { current: 3, previous: 0, windowStart: 0 };
    // Most of the way through the next window, the old count barely weighs.
    const { decision } = decide(spent, rule, rule.windowMs + rule.windowMs * 0.9);
    assert.equal(decision.allowed, true);
  });

  it("forgets entirely after two idle windows", () => {
    const stale = { current: 99, previous: 99, windowStart: 0 };
    const { decision } = decide(stale, rule, rule.windowMs * 5);
    assert.equal(decision.allowed, true);
  });

  it("reports a usable retry delay when denied", () => {
    const spent = { current: 3, previous: 0, windowStart: 0 };
    const { decision } = decide(spent, rule, 30_000);
    assert.equal(decision.allowed, false);
    assert.ok(decision.retryAfterMs > 0 && decision.retryAfterMs <= rule.windowMs);
  });

  it("does not consume budget on a denied request", () => {
    const spent = { current: 3, previous: 0, windowStart: 0 };
    const { next } = decide(spent, rule, 1000);
    assert.equal(next.current, 3, "a rejected request incremented the counter");
  });

  it("namespaces per operation and subject", () => {
    assert.notEqual(
      rateLimitKey("askQuestion", "patient-1"),
      rateLimitKey("documentUpload", "patient-1"),
    );
    assert.notEqual(
      rateLimitKey("askQuestion", "patient-1"),
      rateLimitKey("askQuestion", "patient-2"),
    );
  });

  it("keeps two subjects independent end to end", async () => {
    const store = memoryCounterStore();
    for (let i = 0; i < RATE_LIMITS.askQuestion.limit; i += 1) {
      await checkRateLimit(store, "askQuestion", "a");
    }

    assert.equal((await checkRateLimit(store, "askQuestion", "a")).allowed, false);
    assert.equal((await checkRateLimit(store, "askQuestion", "b")).allowed, true);
  });

  it("prices the expensive operations more tightly than the cheap one", () => {
    assert.ok(RATE_LIMITS.documentUpload.limit < RATE_LIMITS.riskAssessment.limit);
    assert.ok(RATE_LIMITS.askQuestion.limit < RATE_LIMITS.riskAssessment.limit);
  });
});

/* --------------------------------------------------------------- cache */

describe("cache key safety", () => {
  it("rejects a patient-scoped key with no subject", () => {
    // The failure this exists for: "summary" serves one patient's summary to
    // another, and nothing errors.
    assert.throws(() => assertSafeKey("summary"), /carries no subject/);
    assert.throws(() => assertSafeKey("twin"), /carries no subject/);
  });

  it("accepts a shared-namespace key with no subject", () => {
    assert.doesNotThrow(() => assertSafeKey(sharedKey("knowledge", "abc")));
    assert.doesNotThrow(() => assertSafeKey(sharedKey("embedding", "abc")));
  });

  it("rejects an unknown namespace", () => {
    assert.throws(() => assertSafeKey("random:thing"), /known namespace/);
  });

  it("patientKey requires a patient id", () => {
    assert.throws(() => patientKey("summary", ""), /requires a patient id/);
  });

  it("builds distinct keys per patient", () => {
    assert.notEqual(patientKey("twin", "p1"), patientKey("twin", "p2"));
    assert.doesNotThrow(() => assertSafeKey(patientKey("twin", "p1")));
  });

  it("stores and reads through", async () => {
    setCacheDriver(memoryDriver());
    let computed = 0;

    const compute = async () => {
      computed += 1;
      return { value: 42 };
    };

    const key = patientKey("summary", "p1");
    assert.deepEqual(await cached(key, 60, compute), { value: 42 });
    assert.deepEqual(await cached(key, 60, compute), { value: 42 });
    assert.equal(computed, 1, "second call did not hit the cache");
  });

  it("falls through to the computation when the driver throws", async () => {
    setCacheDriver({
      async get() {
        throw new Error("redis down");
      },
      async set() {
        throw new Error("redis down");
      },
      async delete() {},
      async deletePrefix() {},
    });

    const value = await cached(patientKey("twin", "p1"), 60, async () => "computed");
    assert.equal(value, "computed");
    setCacheDriver(memoryDriver());
  });

  it("expires entries", async () => {
    const driver = memoryDriver();
    await driver.set(patientKey("risk", "p1"), "v", 0);
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(await driver.get(patientKey("risk", "p1")), null);
  });

  it("deletes by prefix without touching another patient", async () => {
    const driver = memoryDriver();
    await driver.set(patientKey("twin", "p1"), "a", 60);
    await driver.set(patientKey("twin", "p2"), "b", 60);

    await driver.deletePrefix("twin:p1");

    assert.equal(await driver.get(patientKey("twin", "p1")), null);
    assert.equal(await driver.get(patientKey("twin", "p2")), "b");
  });

  it("digests identical text to the same key and different text apart", () => {
    assert.equal(digest("hello world"), digest("hello world"));
    assert.notEqual(digest("hello world"), digest("hello worlds"));
  });
});

/* ---------------------------------------------------------------- jobs */

describe("job retry policy", () => {
  it("backs off exponentially", () => {
    // random() pinned to 1 so the jitter returns the full delay and the
    // growth is observable.
    const one = backoffMs(1, () => 1);
    const three = backoffMs(3, () => 1);
    assert.ok(three > one);
  });

  it("caps the delay so a failing job still retries within the hour", () => {
    assert.ok(backoffMs(20, () => 1) <= 30 * 60 * 1000);
  });

  it("jitters, so an outage does not produce a thundering herd", () => {
    const low = backoffMs(5, () => 0);
    const high = backoffMs(5, () => 1);
    assert.ok(low < high, "jitter had no effect");
    assert.equal(low, 0);
  });

  it("retires a job once attempts are exhausted", () => {
    assert.equal(onFailure(3, 3).status, "DEAD");
    assert.equal(onFailure(3, 3).exhausted, true);
    assert.equal(onFailure(1, 3).status, "QUEUED");
  });

  it("does not retry a permanently broken document", () => {
    // Retrying a corrupt PDF wastes an OCR call and delays telling the patient.
    assert.equal(isRetryable(new Error("This PDF is password-protected")), false);
    assert.equal(isRetryable(new Error("unsupported file type")), false);
    assert.equal(isRetryable(new Error("did not contain enough readable text")), false);
  });

  it("retries transient failures", () => {
    assert.equal(isRetryable(new Error("request timed out")), true);
    assert.equal(isRetryable(new Error("429 rate limit exceeded")), true);
    assert.equal(isRetryable(new Error("ECONNRESET")), true);
    assert.equal(isRetryable(new Error("fetch failed")), true);
  });

  it("retries an unrecognised failure rather than abandoning it", () => {
    assert.equal(isRetryable(new Error("something nobody anticipated")), true);
  });

  it("computes the next run time from a delay", () => {
    const now = new Date("2026-08-05T00:00:00.000Z");
    assert.equal(nextRunAt(now, 60_000), "2026-08-05T00:01:00.000Z");
  });

  it("writes a dead-letter message for the patient, not for a log", () => {
    const message = deadLetterMessage("ECONNRESET");
    assert.match(message, /could not read this document/i);
    assert.match(message, /clearer scan/i);
  });
});

/* --------------------------------------------------------------- plans */

describe("plan limits", () => {
  it("free tier keeps risk intelligence", () => {
    // Local inference, costs nothing per call, and it is the feature most
    // likely to prompt someone to see a doctor.
    assert.equal(PLANS.FREE.riskIntelligence, true);
  });

  it("never expires a patient's documents on any plan", () => {
    for (const plan of Object.values(PLANS)) {
      assert.equal(plan.documentRetentionDays, null);
    }
  });

  it("falls back to free when a subscription lapses, not to nothing", () => {
    assert.equal(effectivePlan("PREMIUM", "PAST_DUE"), "FREE");
    assert.equal(effectivePlan("PREMIUM", "CANCELLED"), "FREE");
    assert.equal(effectivePlan("PREMIUM", "ACTIVE"), "PREMIUM");

    // The property that matters: a failed card must not lock someone out of
    // their own medical record.
    assert.equal(limitsFor("PREMIUM", "CANCELLED").documentRetentionDays, null);
    assert.equal(limitsFor("PREMIUM", "CANCELLED").riskIntelligence, true);
  });

  it("denies uploads past the monthly cap with a message that reassures", () => {
    const check = checkDocumentQuota("FREE", "ACTIVE", 10);
    assert.equal(check.allowed, false);
    assert.match(check.message!, /stays available/);
  });

  it("allows uploads below the cap", () => {
    assert.equal(checkDocumentQuota("FREE", "ACTIVE", 9).allowed, true);
    assert.equal(checkDocumentQuota("PREMIUM", "ACTIVE", 9999).allowed, true);
  });

  it("caps questions per day on the free plan only", () => {
    assert.equal(checkQuestionQuota("FREE", "ACTIVE", 10).allowed, false);
    assert.equal(checkQuestionQuota("PREMIUM", "ACTIVE", 10_000).allowed, true);
  });

  it("gates only the AI summary, not the deterministic one", () => {
    assert.equal(hasFeature("FREE", "ACTIVE", "aiHealthSummary"), false);
    assert.equal(hasFeature("PREMIUM", "ACTIVE", "aiHealthSummary"), true);
  });

  it("computes UTC period boundaries", () => {
    const now = new Date("2026-08-05T13:45:00.000Z");
    assert.equal(monthStart(now), "2026-08-01T00:00:00.000Z");
    assert.equal(dayStart(now), "2026-08-05T00:00:00.000Z");
  });
});
