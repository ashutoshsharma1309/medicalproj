/**
 * Plan limits.
 *
 * Phase 6 stops short of billing, so nothing here charges anyone. What it does
 * is make the *enforcement* path real, so that adding a payment provider later
 * is a matter of writing to `subscriptions` rather than retrofitting entitlement
 * checks into every feature.
 *
 * Two decisions shaped the free tier, and both are product judgements rather
 * than technical ones.
 *
 * **Nothing already uploaded is ever taken away.** A patient who uploads their
 * full history and then hits a cap must keep access to every document, every
 * derived record, and their Health Twin. Gating *retrieval* of a person's own
 * medical record behind a payment is not a business model, it is a hostage
 * situation. Free limits are therefore on new work, never on stored data.
 *
 * **Safety features are never gated.** The anti-diagnosis guardrails, the
 * allergy display, the source attribution and the disclaimers exist to prevent
 * harm. A tier where the safety rails are the paid upgrade is worse than
 * having no tiers.
 */

export type Plan = "FREE" | "PREMIUM";

export type SubscriptionState = "ACTIVE" | "PAST_DUE" | "CANCELLED";

export type PlanLimits = {
  /** Documents that may be uploaded per calendar month. Null is unlimited. */
  documentsPerMonth: number | null;
  /** Questions to Ask AVERIS per day. Null is unlimited. */
  questionsPerDay: number | null;
  /** Whether ML risk assessment is available. */
  riskIntelligence: boolean;
  /** Whether the AI-written health summary is available. */
  aiHealthSummary: boolean;
  /** Retention of stored documents, in days. Null means indefinite. */
  documentRetentionDays: number | null;
};

export const PLANS: Record<Plan, PlanLimits> = {
  FREE: {
    documentsPerMonth: 10,
    questionsPerDay: 10,
    // Risk assessment stays on: it is local inference, it costs nothing per
    // call, and it is the feature most likely to prompt someone to talk to a
    // doctor. Putting it behind a paywall would be indefensible.
    riskIntelligence: true,
    aiHealthSummary: false,
    // Never expire a patient's medical records. The deterministic summary,
    // timeline and twin all keep working; only the AI-written narration is
    // withheld.
    documentRetentionDays: null,
  },
  PREMIUM: {
    documentsPerMonth: null,
    questionsPerDay: null,
    riskIntelligence: true,
    aiHealthSummary: true,
    documentRetentionDays: null,
  },
};

/**
 * The plan actually in force.
 *
 * A lapsed premium subscription falls back to free rather than to nothing.
 * Locking someone out of their own health record over a failed card is not an
 * outcome any healthcare product should be able to produce.
 */
export function effectivePlan(plan: Plan, status: SubscriptionState): Plan {
  return status === "ACTIVE" ? plan : "FREE";
}

export function limitsFor(plan: Plan, status: SubscriptionState = "ACTIVE"): PlanLimits {
  return PLANS[effectivePlan(plan, status)];
}

export type QuotaCheck = {
  allowed: boolean;
  used: number;
  limit: number | null;
  /** Shown to the patient when denied. Explains the cap and what still works. */
  message?: string;
};

export function checkDocumentQuota(
  plan: Plan,
  status: SubscriptionState,
  usedThisMonth: number,
): QuotaCheck {
  const limit = limitsFor(plan, status).documentsPerMonth;
  if (limit === null) return { allowed: true, used: usedThisMonth, limit: null };

  if (usedThisMonth >= limit) {
    return {
      allowed: false,
      used: usedThisMonth,
      limit,
      message:
        `You have uploaded ${usedThisMonth} of ${limit} documents included this month. ` +
        `Everything already in your records stays available — this only pauses new uploads ` +
        `until next month.`,
    };
  }

  return { allowed: true, used: usedThisMonth, limit };
}

export function checkQuestionQuota(
  plan: Plan,
  status: SubscriptionState,
  usedToday: number,
): QuotaCheck {
  const limit = limitsFor(plan, status).questionsPerDay;
  if (limit === null) return { allowed: true, used: usedToday, limit: null };

  if (usedToday >= limit) {
    return {
      allowed: false,
      used: usedToday,
      limit,
      message:
        `You have asked ${usedToday} of ${limit} questions included today. ` +
        `Your records, timeline and risk assessments are all still available.`,
    };
  }

  return { allowed: true, used: usedToday, limit };
}

export function hasFeature(
  plan: Plan,
  status: SubscriptionState,
  feature: keyof Pick<PlanLimits, "riskIntelligence" | "aiHealthSummary">,
): boolean {
  return limitsFor(plan, status)[feature];
}

/** Start of the current UTC month, for counting uploads. */
export function monthStart(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

/** Start of the current UTC day, for counting questions. */
export function dayStart(now: Date): string {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  ).toISOString();
}
