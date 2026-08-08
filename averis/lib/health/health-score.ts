/**
 * The AVERIS health score.
 *
 * ── Read this before changing anything here ────────────────────────────────
 *
 * A single number out of 100 on a health dashboard is the most dangerous
 * component in this product. It is the thing a patient will screenshot, quote
 * to a relative, and make a decision about. "82/100" *looks* like a clinical
 * assessment, and no arrangement of disclaimers around it fully undoes that.
 *
 * So it is built under four constraints, and each one costs something:
 *
 * **1. It is a monitoring-coverage score, not a health assessment.** Every
 * input is something AVERIS actually observed in the window: whether vitals sat
 * inside published ranges, whether the device was reporting, whether alerts
 * fired, what the risk engine said. It contains nothing about the person's
 * medical history, and it is named and captioned accordingly everywhere it
 * appears.
 *
 * **2. It is fully decomposable.** `HealthScore.factors` lists every component
 * with its weight and its own contribution, and the UI shows them. A score that
 * cannot be taken apart is a black box, and the whole product position is that
 * AVERIS is not one.
 *
 * **3. It refuses to exist without data.** No readings means `null`, not 100
 * and not 50. A band that was never worn must not produce a reassuring number —
 * that is the single worst failure available to this component, because
 * "nobody measured anything" and "everything is fine" would look identical.
 *
 * **4. Nothing downstream consumes it.** No alert, no escalation, no clinical
 * view is driven by this number. It is a summary for a patient's own screen.
 * The clinician's caseload sorts on the risk engine and open emergencies, which
 * are computed independently — so if this score were wrong, nobody's care would
 * change.
 *
 * Pure and fully tested. No database, no clock beyond what callers pass in.
 */

export type HealthScoreBand = "STABLE" | "WATCH" | "ELEVATED" | "CRITICAL";

export type ScoreFactor = {
  key: string;
  label: string;
  /** Share of the total this factor can move, 0–1. */
  weight: number;
  /** How well this factor scored, 0–1. */
  attained: number;
  /** Points this factor contributed to the final score. */
  points: number;
  /** Plain sentence a patient can check against their own chart. */
  detail: string;
};

export type HealthScore = {
  /** 0–100, or null when there is not enough measurement to say anything. */
  score: number | null;
  band: HealthScoreBand;
  factors: ScoreFactor[];
  /** Why there is no score, when there is none. */
  unavailableReason: string | null;
  /** Readings the score was computed from. */
  readingCount: number;
  windowHours: number;
};

export type ScoreInput = {
  /** Oldest first or newest first — the score does not depend on order. */
  readings: {
    heart_rate: number | null;
    spo2: number | null;
    temperature: number | null;
    recorded_at: string;
  }[];
  alerts: { severity: string }[];
  openEmergencies: number;
  risk: { score: number; level: string } | null;
  /** Whether the device is currently reporting. */
  deviceReporting: boolean;
  windowHours: number;
  now: number;
};

/**
 * Published ranges for a resting adult — the same constants the alert rules
 * use, deliberately, so the score cannot disagree with the alerts a patient is
 * looking at on the same screen.
 */
const IN_RANGE = {
  heartRate: { min: 50, max: 120 },
  spo2: { min: 94, max: 100 },
  temperature: { min: 35.5, max: 38.0 },
} as const;

/**
 * Weights.
 *
 * Time-in-range dominates because it is the most direct thing AVERIS measures.
 * Coverage is second and is not a health signal at all — it is an honesty
 * signal: a score computed from four readings should not look like one
 * computed from four hundred.
 */
const WEIGHTS = {
  timeInRange: 0.4,
  alerts: 0.25,
  risk: 0.2,
  coverage: 0.15,
} as const;

/** Below this many readings, the window is too thin to summarise. */
export const MINIMUM_READINGS = 10;

export function calculateHealthScore(input: ScoreInput): HealthScore {
  const { readings, windowHours } = input;

  if (readings.length === 0) {
    return unavailable(
      "No readings in this period. AVERIS has nothing to summarise — this usually means the band was not worn or not connected.",
      0,
      windowHours,
    );
  }

  if (readings.length < MINIMUM_READINGS) {
    // Deliberately a refusal rather than a low-confidence number. A score from
    // six readings would be indistinguishable on screen from one built from
    // six hundred, and the patient has no way to tell.
    return unavailable(
      `Only ${readings.length} readings in this period — too few to summarise. AVERIS needs at least ${MINIMUM_READINGS}.`,
      readings.length,
      windowHours,
    );
  }

  const factors: ScoreFactor[] = [
    timeInRangeFactor(readings),
    alertFactor(input.alerts, input.openEmergencies),
    riskFactor(input.risk),
    coverageFactor(readings, input.deviceReporting, windowHours, input.now),
  ];

  const score = Math.round(
    factors.reduce((sum, factor) => sum + factor.points, 0),
  );

  return {
    score: Math.max(0, Math.min(100, score)),
    band: bandFor(score, input.openEmergencies),
    factors,
    unavailableReason: null,
    readingCount: readings.length,
    windowHours,
  };
}

/**
 * Time in range — the proportion of measurements inside published ranges.
 *
 * Averaged across the channels that actually reported. A band with no
 * thermometer is not penalised for having no thermometer: an absent sensor is
 * a coverage question, and it is scored as one below.
 */
function timeInRangeFactor(readings: ScoreInput["readings"]): ScoreFactor {
  const channels = [
    { key: "heart_rate" as const, range: IN_RANGE.heartRate, label: "heart rate" },
    { key: "spo2" as const, range: IN_RANGE.spo2, label: "blood oxygen" },
    { key: "temperature" as const, range: IN_RANGE.temperature, label: "temperature" },
  ];

  const rates: number[] = [];
  const outOfRange: string[] = [];

  for (const channel of channels) {
    const values = readings
      .map((r) => r[channel.key])
      .filter((v): v is number => typeof v === "number");

    if (values.length === 0) continue;

    const inRange = values.filter(
      (v) => v >= channel.range.min && v <= channel.range.max,
    ).length;

    const rate = inRange / values.length;
    rates.push(rate);
    if (rate < 0.95) {
      outOfRange.push(`${channel.label} ${Math.round((1 - rate) * 100)}% outside range`);
    }
  }

  const attained = rates.length > 0 ? rates.reduce((a, b) => a + b, 0) / rates.length : 0;

  return {
    key: "timeInRange",
    label: "Measurements in range",
    weight: WEIGHTS.timeInRange,
    attained,
    points: attained * WEIGHTS.timeInRange * 100,
    detail:
      rates.length === 0
        ? "No usable measurements."
        : outOfRange.length === 0
          ? `${Math.round(attained * 100)}% of measurements sat inside published ranges.`
          : `${Math.round(attained * 100)}% inside published ranges — ${outOfRange.join(", ")}.`,
  };
}

/**
 * Alerts, weighted by severity.
 *
 * A single critical alert costs more than several informational ones. An open
 * emergency zeroes this factor outright: while somebody is waiting for a
 * response, no arithmetic about the rest of the window should soften it.
 */
function alertFactor(alerts: { severity: string }[], openEmergencies: number): ScoreFactor {
  const critical = alerts.filter((a) => a.severity === "CRITICAL").length;
  const warning = alerts.filter((a) => a.severity === "WARNING").length;

  if (openEmergencies > 0) {
    return {
      key: "alerts",
      label: "Alerts raised",
      weight: WEIGHTS.alerts,
      attained: 0,
      points: 0,
      detail: `${openEmergencies} emergency event${openEmergencies === 1 ? "" : "s"} still open and awaiting a response.`,
    };
  }

  // 25 points of penalty per critical, 8 per warning, floored at zero.
  const penalty = Math.min(1, critical * 0.25 + warning * 0.08);
  const attained = 1 - penalty;

  return {
    key: "alerts",
    label: "Alerts raised",
    weight: WEIGHTS.alerts,
    attained,
    points: attained * WEIGHTS.alerts * 100,
    detail:
      critical + warning === 0
        ? "No threshold alerts in this period."
        : `${critical} critical and ${warning} warning alert${warning === 1 ? "" : "s"}.`,
  };
}

/**
 * The AI risk assessment, inverted.
 *
 * Absent is scored as neutral (0.7), not as perfect. The engine not having run
 * is not evidence of health, and awarding full marks for it would let a patient
 * whose analysis never ran outscore one whose analysis found nothing wrong.
 */
function riskFactor(risk: ScoreInput["risk"]): ScoreFactor {
  if (!risk) {
    return {
      key: "risk",
      label: "AI risk assessment",
      weight: WEIGHTS.risk,
      attained: 0.7,
      points: 0.7 * WEIGHTS.risk * 100,
      detail: "No assessment in this period — scored as neutral, not as healthy.",
    };
  }

  const attained = Math.max(0, 1 - risk.score);

  return {
    key: "risk",
    label: "AI risk assessment",
    weight: WEIGHTS.risk,
    attained,
    points: attained * WEIGHTS.risk * 100,
    detail: `AVERIS assessed risk at ${Math.round(risk.score * 100)}% (${risk.level.toLowerCase()}).`,
  };
}

/**
 * Coverage — how much of the window was actually monitored.
 *
 * Not a health signal. It is here so the score is honest about its own
 * foundations: a patient who wore their band for one hour of a day should see
 * that reflected, rather than a confident number built on a twenty-fourth of
 * the evidence.
 */
function coverageFactor(
  readings: ScoreInput["readings"],
  deviceReporting: boolean,
  windowHours: number,
  now: number,
): ScoreFactor {
  const timestamps = readings
    .map((r) => Date.parse(r.recorded_at))
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b);

  if (timestamps.length < 2) {
    return {
      key: "coverage",
      label: "Monitoring coverage",
      weight: WEIGHTS.coverage,
      attained: 0,
      points: 0,
      detail: "Not enough readings to measure coverage.",
    };
  }

  // Largest silence in the window, as a fraction of the window itself.
  let longestGapMs = 0;
  for (let i = 1; i < timestamps.length; i += 1) {
    longestGapMs = Math.max(longestGapMs, timestamps[i] - timestamps[i - 1]);
  }

  const windowMs = windowHours * 3600_000;
  const spanMs = timestamps[timestamps.length - 1] - timestamps[0];
  const staleMs = now - timestamps[timestamps.length - 1];

  const spanShare = Math.min(1, spanMs / windowMs);
  const gapPenalty = Math.min(1, longestGapMs / windowMs);

  // A device that stopped reporting costs coverage even if the earlier part of
  // the window was complete — right now is the part a patient cares about.
  //
  // The 0.15 floor matters: `deviceReporting` is a categorical answer from the
  // device service, derived from the connection status as well as the last
  // reading. When it says a band is not reporting, the score must reflect that
  // even if the arithmetic on timestamps alone has not caught up — otherwise a
  // device that dropped off seconds ago scores exactly like one still on air.
  const stalePenalty = deviceReporting
    ? 0
    : Math.max(0.15, Math.min(0.4, staleMs / windowMs));

  const attained = Math.max(0, spanShare - gapPenalty * 0.5 - stalePenalty);
  const gapMinutes = Math.round(longestGapMs / 60_000);

  return {
    key: "coverage",
    label: "Monitoring coverage",
    weight: WEIGHTS.coverage,
    attained,
    points: attained * WEIGHTS.coverage * 100,
    detail: deviceReporting
      ? `${readings.length} readings spanning ${Math.round((spanMs / windowMs) * 100)}% of the period` +
        (gapMinutes >= 15 ? `, longest gap ${gapMinutes} minutes.` : ".")
      : `Device is not currently reporting — last reading ${Math.round(staleMs / 60_000)} minutes ago.`,
  };
}

/**
 * The word shown beside the number.
 *
 * An open emergency forces CRITICAL regardless of arithmetic. A patient with
 * an unanswered emergency must never see "Stable" because the preceding six
 * hours were quiet — that is the one combination where a composite average
 * actively misleads.
 */
export function bandFor(score: number, openEmergencies = 0): HealthScoreBand {
  if (openEmergencies > 0) return "CRITICAL";
  if (score >= 80) return "STABLE";
  if (score >= 60) return "WATCH";
  if (score >= 40) return "ELEVATED";
  return "CRITICAL";
}

export const BAND_LABEL: Record<HealthScoreBand, string> = {
  STABLE: "Stable",
  WATCH: "Worth watching",
  ELEVATED: "Elevated",
  CRITICAL: "Needs attention",
};

/**
 * What the band means, in the patient's terms.
 *
 * Every one of these ends by pointing at a person rather than at a next step
 * AVERIS invented. The platform reports; it does not advise.
 */
export const BAND_MEANING: Record<HealthScoreBand, string> = {
  STABLE:
    "Your measurements have mostly stayed inside published ranges during this period.",
  WATCH:
    "Some measurements moved outside published ranges, or monitoring was interrupted.",
  ELEVATED:
    "Several measurements sat outside published ranges during this period. Your care team can see the same data.",
  CRITICAL:
    "Measurements crossed escalation thresholds, or an emergency is still open. Your care team has been notified.",
};

function unavailable(
  reason: string,
  readingCount: number,
  windowHours: number,
): HealthScore {
  return {
    score: null,
    band: "WATCH",
    factors: [],
    unavailableReason: reason,
    readingCount,
    windowHours,
  };
}
