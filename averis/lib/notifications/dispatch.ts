/**
 * Notification dispatch — deciding what goes out, over which channel, and when.
 *
 * ── The rule this codebase has held since Phase 6, restated ────────────────
 *
 * **A channel that silently does nothing is worse than an absent one**, because
 * the code reads as though people are being told and they are not.
 *
 * So there are no stub adapters here. A channel is either configured and
 * genuinely delivers, or it reports itself unavailable and the dispatcher
 * *says so* in the result. `dispatchPlan` returns which channels were skipped
 * and why, and the caller records it — a critical alert that reached nobody
 * because SMS was unconfigured is a fact somebody needs, not a silent no-op.
 *
 * ── Priority is not decoration ─────────────────────────────────────────────
 *
 * A fall and a low battery must not share a delivery path. Priority decides
 * three separate things:
 *
 *   · **which channels are attempted** — in-app for everything, email above
 *     routine, SMS only for critical, because an SMS at 3am for a low battery
 *     is how a carer mutes the number the emergency will arrive on
 *   · **whether quiet hours apply** — they do not to critical
 *   · **whether it may be batched** — routine notices are collected, critical
 *     ones never wait for company
 *
 * ── Why this module is pure ────────────────────────────────────────────────
 *
 * It decides; it does not send. Delivery lives in adapters behind an interface,
 * so the decision logic — which is the part with clinical consequences — is
 * testable without a mail server, and a future SMS provider is a new adapter
 * rather than a change to the rules about who gets woken up.
 */

export type NotificationPriority = "CRITICAL" | "URGENT" | "ROUTINE";

export type Channel = "in_app" | "email" | "sms" | "push";

export type NotificationRequest = {
  /** Who it is for. An app user id, never an email address at this layer. */
  recipientId: string;
  priority: NotificationPriority;
  /** Stable identifier for the kind of notice, for deduplication. */
  kind: string;
  title: string;
  body: string;
  /** Relative path, never an external URL. */
  href?: string;
  /** Set for anything arising from a specific emergency, for dedup. */
  emergencyId?: string;
};

export type ChannelAvailability = Record<Channel, boolean>;

export type RecipientPreferences = {
  /** Channels the recipient has turned off. Never applies to CRITICAL. */
  optedOut: Channel[];
  /** Local hour range during which non-critical notices are held. */
  quietHours?: { fromHour: number; toHour: number };
  /** IANA zone. Quiet hours in the server's timezone are quiet hours for nobody. */
  timeZone?: string;
};

export type PlannedDelivery = {
  channel: Channel;
  /** When to attempt it. Now, or after quiet hours end. */
  deferUntil: string | null;
};

export type SkippedDelivery = {
  channel: Channel;
  reason: "not_configured" | "opted_out" | "not_for_priority";
  /** A sentence for the log, so a silent gap becomes a visible one. */
  detail: string;
};

export type DispatchPlan = {
  deliver: PlannedDelivery[];
  skipped: SkippedDelivery[];
  /**
   * True when a CRITICAL notice will reach the recipient by no channel other
   * than in-app. The single most important field here: it is how "we thought
   * they were told" becomes visible instead of assumed.
   */
  degraded: boolean;
  /** Set when the plan reaches nobody at all. */
  undeliverable: string | null;
};

/**
 * Which channels each priority may use.
 *
 * In-app is always attempted, for every priority, because it is the only
 * channel that cannot fail silently — the notice is a row in a table the
 * recipient's own page reads.
 */
const CHANNELS_FOR: Record<NotificationPriority, Channel[]> = {
  // A fall. Everything, immediately, quiet hours ignored.
  CRITICAL: ["in_app", "push", "sms", "email"],
  // A deteriorating trend. Reaches a phone but does not ring it at 3am.
  URGENT: ["in_app", "push", "email"],
  // A summary is ready, a baseline was learned.
  ROUTINE: ["in_app"],
};

/**
 * Builds the plan.
 *
 * Pure: takes availability and preferences as arguments rather than reading
 * configuration, so every branch below is reachable in a test — including the
 * one where nothing is configured, which is the state a fresh deployment is in
 * and therefore the one most likely to be wrong.
 */
export function dispatchPlan(
  request: NotificationRequest,
  availability: ChannelAvailability,
  preferences: RecipientPreferences = { optedOut: [] },
  now = new Date(),
): DispatchPlan {
  const allowed = CHANNELS_FOR[request.priority];
  const deliver: PlannedDelivery[] = [];
  const skipped: SkippedDelivery[] = [];

  const inQuietHours = isInQuietHours(preferences, now);

  for (const channel of ALL_CHANNELS) {
    if (!allowed.includes(channel)) {
      skipped.push({
        channel,
        reason: "not_for_priority",
        detail: `${channel} is not used for ${request.priority} notices.`,
      });
      continue;
    }

    if (!availability[channel]) {
      skipped.push({
        channel,
        reason: "not_configured",
        // Named as a gap rather than logged as nothing. This is the line that
        // turns "SMS was never set up" from an assumption into a record.
        detail: `${channel} is not configured in this deployment, so this notice did not go out over it.`,
      });
      continue;
    }

    // Opt-out never applies to a critical notice. A patient who muted alerts
    // has muted convenience, not an emergency — and a carer who turned off SMS
    // for battery warnings did not consent to missing a fall.
    if (request.priority !== "CRITICAL" && preferences.optedOut.includes(channel)) {
      skipped.push({
        channel,
        reason: "opted_out",
        detail: `The recipient has turned off ${channel} for non-critical notices.`,
      });
      continue;
    }

    const defer =
      request.priority !== "CRITICAL" && inQuietHours && channel !== "in_app"
        ? quietHoursEnd(preferences, now)
        : null;

    deliver.push({ channel, deferUntil: defer });
  }

  const reachedBeyondApp = deliver.some((d) => d.channel !== "in_app");

  return {
    deliver,
    skipped,
    degraded: request.priority === "CRITICAL" && !reachedBeyondApp,
    undeliverable:
      deliver.length === 0
        ? "No channel is available for this notice. Nobody was told."
        : null,
  };
}

const ALL_CHANNELS: Channel[] = ["in_app", "push", "sms", "email"];

/**
 * Whether the recipient is inside their quiet hours.
 *
 * Computed in the recipient's own timezone. A quiet-hours window evaluated in
 * the server's timezone silences the wrong eight hours, which for a
 * deployment in India served from a European region is the middle of the
 * working day.
 */
export function isInQuietHours(preferences: RecipientPreferences, now: Date): boolean {
  if (!preferences.quietHours) return false;

  const { fromHour, toHour } = preferences.quietHours;

  const hour = Number(
    new Intl.DateTimeFormat("en-GB", {
      hour: "numeric",
      hour12: false,
      timeZone: preferences.timeZone ?? "UTC",
    }).format(now),
  );

  // A window that wraps midnight — 22:00 to 07:00 — is the normal case, and
  // the naive `hour >= from && hour < to` comparison silences nothing at all
  // for it.
  return fromHour <= toHour
    ? hour >= fromHour && hour < toHour
    : hour >= fromHour || hour < toHour;
}

function quietHoursEnd(preferences: RecipientPreferences, now: Date): string {
  if (!preferences.quietHours) return now.toISOString();

  const zone = preferences.timeZone ?? "UTC";
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", { hour: "numeric", hour12: false, timeZone: zone }).format(now),
  );

  const { toHour } = preferences.quietHours;
  const hoursUntil = hour < toHour ? toHour - hour : 24 - hour + toHour;

  return new Date(now.getTime() + hoursUntil * 3600_000).toISOString();
}

/**
 * Whether two notices are the same thing arriving twice.
 *
 * A device below the SpO₂ threshold produces one emergency, and every
 * component that hears about it would otherwise notify separately. Keyed on
 * the emergency rather than the message text, because two systems describing
 * the same event in different words are still describing one event.
 */
export function deduplicationKey(request: NotificationRequest): string {
  return request.emergencyId
    ? `${request.recipientId}:emergency:${request.emergencyId}`
    : `${request.recipientId}:${request.kind}`;
}

/**
 * How long a notice suppresses a repeat of itself.
 *
 * Critical notices repeat soonest: an unanswered emergency should be raised
 * again, because the first notification arriving while a phone was face-down
 * is not the same as somebody having seen it. Routine notices barely repeat at
 * all.
 */
export function suppressionWindowMs(priority: NotificationPriority): number {
  return priority === "CRITICAL"
    ? 5 * 60_000
    : priority === "URGENT"
      ? 60 * 60_000
      : 24 * 60 * 60_000;
}
