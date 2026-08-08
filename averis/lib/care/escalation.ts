/**
 * Escalation — when a finding becomes somebody's problem.
 *
 * An alert says a measurement crossed a threshold. An emergency event says a
 * human needs to respond, and it appears in a clinician's queue until one
 * does. The distance between those two claims is this file.
 *
 * ── Why this is rules and not a model ──────────────────────────────────────
 *
 * The same reasoning as the threshold alerts and the Phase 3 insight engine:
 * an escalation wakes a person up, and the person woken deserves to know
 * exactly what tripped it. "SpO2 was 86% and the escalation threshold is 90%"
 * is checkable at 3am; "the model was confident" is not.
 *
 * The AI engine can raise one — `RAPID_DETERIORATION` exists precisely so a
 * trend nobody's threshold catches can still reach a clinician — but even then
 * the *decision* is a rule applied to the model's output, and the evidence
 * travels with the event.
 *
 * ── The two suppressions, and why they are not the same ────────────────────
 *
 * `shouldEscalate` suppresses a repeat of something already open. This is not
 * the alert-level suppression repeated at a second layer: alerts dedupe so the
 * patient's alert list stays readable, and emergencies dedupe so a clinician's
 * response queue does not fill with the same unanswered event 300 times while
 * they are on their way to the patient. Both matter; neither substitutes for
 * the other, because an acknowledged emergency stops suppressing new *alerts*
 * and an open emergency must keep suppressing new *emergencies*.
 *
 * Pure — no database, no clock beyond what callers pass in. The runtime that
 * actually raises these is the Python ingest service, and `escalation.py` is a
 * port of this file covered by the same expectations.
 */

export type EmergencyType =
  | "FALL_DETECTED"
  | "SEVERE_HYPOXIA"
  | "EXTREME_HEART_RATE"
  | "RAPID_DETERIORATION"
  | "DEVICE_LOST"
  | "MANUAL_ESCALATION";

export type EmergencySeverity = "INFO" | "WARNING" | "CRITICAL";

export type EmergencyStatus =
  | "NEW"
  | "ACKNOWLEDGED"
  | "IN_PROGRESS"
  | "RESOLVED"
  | "DISMISSED";

export type DetectedBy = "RULE_ENGINE" | "AI_ENGINE" | "PATIENT" | "CLINICIAN";

/** A candidate escalation, before anything has been written down. */
export type EmergencyCandidate = {
  eventType: EmergencyType;
  severity: EmergencySeverity;
  detectedBy: DetectedBy;
  /** One sentence a clinician can act on without opening the chart. */
  summary: string;
  /**
   * What the engine saw. An emergency a clinician cannot trace back to numbers
   * is one they have to take on trust at the worst possible moment.
   */
  evidence: Record<string, unknown>;
};

/** The subset of an alert this module needs. */
export type AlertLike = {
  alertType: string;
  severity: EmergencySeverity;
  message: string;
  observedValue: number | null;
  thresholdValue: number | null;
};

/** The subset of an AI assessment this module needs. */
export type AssessmentLike = {
  riskLevel: "LOW" | "MODERATE" | "HIGH" | "CRITICAL" | null;
  riskScore: number | null;
  confidence: number | null;
  /** Human-readable reasons, already produced by the engine. */
  reasons: string[];
  /** Whether the fall model fired on the most recent IMU window. */
  fallDetected: boolean;
  fallConfidence: number | null;
  /** Direction of travel over the assessment window, if the engine reported one. */
  deteriorating: boolean;
};

export type OpenEmergency = {
  eventType: EmergencyType;
  severity: EmergencySeverity;
  status: EmergencyStatus;
};

/**
 * Risk score at which the AI engine may escalate on its own.
 *
 * 0.85 rather than 0.7, and CRITICAL rather than HIGH, because this threshold
 * buys a clinician's attention with a model's opinion. Set it low and the
 * queue fills with assessments nobody can check; set it too high and the
 * trend-only deterioration the thresholds cannot see never reaches anyone.
 */
export const AI_ESCALATION_SCORE = 0.85;

/**
 * How long a device may stay silent before that is itself the emergency.
 *
 * Fifteen minutes, not one: bands drop off Wi-Fi, phones move out of
 * Bluetooth range, and a system that escalates on every gap teaches its
 * clinicians to dismiss escalations. Fifteen minutes of nothing from a device
 * that was reporting is no longer a network blip.
 */
export const DEVICE_SILENCE_MS = 15 * 60 * 1000;

const SEVERITY_RANK: Record<EmergencySeverity, number> = {
  INFO: 1,
  WARNING: 2,
  CRITICAL: 3,
};

/** Statuses that mean nobody has finished dealing with it yet. */
export const OPEN_STATUSES: EmergencyStatus[] = ["NEW", "ACKNOWLEDGED", "IN_PROGRESS"];

/**
 * Which threshold alerts are emergencies in their own right.
 *
 * A WARNING never appears here. The whole point of two levels is that one of
 * them can be looked at later, and an escalation path that treats them alike
 * produces a queue with no priority in it.
 */
export function fromAlerts(alerts: AlertLike[]): EmergencyCandidate[] {
  const candidates: EmergencyCandidate[] = [];

  for (const alert of alerts) {
    if (alert.severity !== "CRITICAL") continue;

    if (alert.alertType === "FALL_SUSPECTED") {
      candidates.push({
        eventType: "FALL_DETECTED",
        severity: "CRITICAL",
        detectedBy: "RULE_ENGINE",
        summary: "The device reported a movement pattern consistent with a fall.",
        evidence: { alertType: alert.alertType, source: "movement_status" },
      });
      continue;
    }

    if (alert.alertType === "SPO2_LOW") {
      candidates.push({
        eventType: "SEVERE_HYPOXIA",
        severity: "CRITICAL",
        detectedBy: "RULE_ENGINE",
        summary: alert.message,
        evidence: {
          alertType: alert.alertType,
          observed: alert.observedValue,
          threshold: alert.thresholdValue,
        },
      });
      continue;
    }

    if (alert.alertType === "HEART_RATE_HIGH" || alert.alertType === "HEART_RATE_LOW") {
      candidates.push({
        eventType: "EXTREME_HEART_RATE",
        severity: "CRITICAL",
        detectedBy: "RULE_ENGINE",
        summary: alert.message,
        evidence: {
          alertType: alert.alertType,
          observed: alert.observedValue,
          threshold: alert.thresholdValue,
        },
      });
    }

    // TEMPERATURE_* is deliberately absent. A critical temperature is a real
    // finding and raises an alert, but it is not a minutes-matter event in the
    // way hypoxia, a collapse or an arrhythmia are, and putting it in the same
    // queue would dilute the queue rather than improve the temperature.
  }

  return dedupeByType(candidates);
}

/**
 * Whether the AI assessment is itself an escalation.
 *
 * Two ways in, and they are different claims:
 *
 *   · the fall model fired — a discrete event, like a threshold crossing
 *   · risk is critical *and* rising — a trend, which is the one thing the
 *     thresholds structurally cannot see, since every individual reading in a
 *     slow decline can sit inside the normal band
 *
 * A high score that is flat does not escalate. A patient who has been at 0.86
 * for a week is a patient whose clinician already knows.
 */
export function fromAssessment(assessment: AssessmentLike): EmergencyCandidate[] {
  const candidates: EmergencyCandidate[] = [];

  if (assessment.fallDetected) {
    candidates.push({
      eventType: "FALL_DETECTED",
      severity: "CRITICAL",
      detectedBy: "AI_ENGINE",
      summary: "The fall model detected a movement pattern consistent with a fall.",
      evidence: {
        model: "fall_detector",
        confidence: assessment.fallConfidence,
        // Named in the evidence because the model is trained on synthetic
        // motion, and a clinician reading this should know that without
        // having to find the model card.
        caveat: "trained on synthetic motion data",
      },
    });
  }

  const score = assessment.riskScore ?? 0;
  if (
    assessment.riskLevel === "CRITICAL" &&
    score >= AI_ESCALATION_SCORE &&
    assessment.deteriorating
  ) {
    candidates.push({
      eventType: "RAPID_DETERIORATION",
      severity: "CRITICAL",
      detectedBy: "AI_ENGINE",
      summary:
        assessment.reasons.length > 0
          ? `Risk assessment reached ${Math.round(score * 100)}% and is rising: ${assessment.reasons
              .slice(0, 3)
              .join("; ")}.`
          : `Risk assessment reached ${Math.round(score * 100)}% and is rising.`,
      evidence: {
        riskScore: score,
        riskLevel: assessment.riskLevel,
        confidence: assessment.confidence,
        reasons: assessment.reasons.slice(0, 5),
      },
    });
  }

  return dedupeByType(candidates);
}

/**
 * A device that has stopped reporting.
 *
 * WARNING, not CRITICAL. Nothing is known to be wrong with the patient — that
 * is precisely the problem, and it is a different problem from a measured
 * emergency. Ranking a lost signal alongside a fall would teach clinicians
 * that red does not mean red.
 *
 * A device that was never connected does not escalate: `lastReadingAt` of null
 * is a band still in its box, not a band that went quiet.
 */
export function fromSilence(
  lastReadingAt: string | null,
  now: number,
  silenceMs = DEVICE_SILENCE_MS,
): EmergencyCandidate[] {
  if (!lastReadingAt) return [];

  const last = Date.parse(lastReadingAt);
  if (Number.isNaN(last)) return [];

  const silent = now - last;
  if (silent < silenceMs) return [];

  const minutes = Math.floor(silent / 60000);
  return [
    {
      eventType: "DEVICE_LOST",
      severity: "WARNING",
      detectedBy: "RULE_ENGINE",
      summary: `No readings for ${minutes} minutes. This patient is not currently being monitored.`,
      evidence: { lastReadingAt, silentMinutes: minutes },
    },
  ];
}

/**
 * Whether a candidate should be written down given what is already open.
 *
 * Mirrors the partial unique index on `emergency_events` — one open event per
 * patient per type — so the application refuses before the database has to,
 * and a caller gets a decision rather than a constraint violation.
 *
 * An escalation still gets through: an open WARNING for a device that has now
 * gone CRITICAL is new information, and the queue must be able to say so.
 */
export function shouldEscalate(
  candidate: EmergencyCandidate,
  open: OpenEmergency[],
): boolean {
  const existing = open.find(
    (e) => e.eventType === candidate.eventType && OPEN_STATUSES.includes(e.status),
  );
  if (!existing) return true;

  return SEVERITY_RANK[candidate.severity] > SEVERITY_RANK[existing.severity];
}

/**
 * Everything a reading and its assessment justify raising, already deduped
 * against what is open.
 *
 * The order matters for the caller that writes them: most severe first, so a
 * partial failure loses the least important event rather than the one that
 * mattered.
 */
export function escalationsFor(input: {
  alerts?: AlertLike[];
  assessment?: AssessmentLike | null;
  lastReadingAt?: string | null;
  now?: number;
  open?: OpenEmergency[];
}): EmergencyCandidate[] {
  const candidates = dedupeByType([
    ...fromAlerts(input.alerts ?? []),
    ...(input.assessment ? fromAssessment(input.assessment) : []),
    ...(input.lastReadingAt !== undefined
      ? fromSilence(input.lastReadingAt, input.now ?? Date.now())
      : []),
  ]);

  return candidates
    .filter((candidate) => shouldEscalate(candidate, input.open ?? []))
    .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
}

/**
 * One event per type, keeping the most severe.
 *
 * The rule engine and the AI engine can both report a fall from the same
 * instant — one from the movement flag, one from the model. That is one fall,
 * and a queue showing it twice makes a clinician check whether the patient
 * fell twice.
 */
function dedupeByType(candidates: EmergencyCandidate[]): EmergencyCandidate[] {
  const best = new Map<EmergencyType, EmergencyCandidate>();

  for (const candidate of candidates) {
    const existing = best.get(candidate.eventType);
    if (!existing || SEVERITY_RANK[candidate.severity] > SEVERITY_RANK[existing.severity]) {
      best.set(candidate.eventType, candidate);
    }
  }

  return [...best.values()];
}

/** Plain-language labels, shared by the queue, the inbox and the assistant. */
export const EMERGENCY_LABEL: Record<EmergencyType, string> = {
  FALL_DETECTED: "Fall detected",
  SEVERE_HYPOXIA: "Severe drop in blood oxygen",
  EXTREME_HEART_RATE: "Extreme heart rate",
  RAPID_DETERIORATION: "Rapidly rising risk",
  DEVICE_LOST: "Device stopped reporting",
  MANUAL_ESCALATION: "Escalated by hand",
};

export type CareNotice = {
  title: string;
  body: string;
  /** Relative, always. An absolute URL here is an open redirect people trust. */
  href: string;
  severity: EmergencySeverity;
};

/**
 * What a care team member is actually told.
 *
 * The patient's name goes in the title and the finding in the body, in that
 * order, because a phone notification truncates and the recipient's first
 * question is always *who*. Everything after the first line is detail they
 * will read on the chart.
 *
 * No measurements beyond the ones already in the summary, and never a
 * suggestion of what to do about it: the notice's job is to get a clinician to
 * the patient, and the chart's job is to inform what happens next.
 */
export function noticeFor(
  candidate: Pick<EmergencyCandidate, "eventType" | "severity" | "summary">,
  patient: { patientId: string; fullName: string },
): CareNotice {
  return {
    title: `${patient.fullName} — ${EMERGENCY_LABEL[candidate.eventType]}`,
    body: candidate.summary,
    href: `/clinical/${patient.patientId}`,
    severity: candidate.severity,
  };
}
