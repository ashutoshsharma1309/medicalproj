/**
 * Impact metrics.
 *
 * ── What this module refuses to do, and why that is the whole design ───────
 *
 * "Impact" in a hackathon deck usually means a number like *"reduces mortality
 * by 30%"* or *"could serve 50 million rural patients"*. AVERIS has not treated
 * a patient. It has no outcome data, no deployment, and no cohort. Any figure
 * of that shape would be invented, and inventing one in a healthcare product is
 * not enthusiasm — it is the same act as inventing a clinical accuracy claim,
 * which this codebase has refused at every phase.
 *
 * So this module computes exactly one kind of thing: **what the prototype
 * itself has actually done.** Readings ingested. Alerts raised. Time from a
 * reading arriving to an alert existing. Every number is a count of rows that
 * exist in this deployment's database, and every one is labelled with where it
 * came from.
 *
 * ── Provenance is the feature ─────────────────────────────────────────────
 *
 * Since Phase 1 every reading carries `is_simulated`, stamped at write time.
 * That flag is what makes an impact panel possible at all: a metric that mixes
 * simulated and measured rows is a metric nobody can interpret, and in a demo —
 * where most rows are simulated — it would be a metric that flatters by
 * construction.
 *
 * Every figure below is therefore split. Not summarised with a footnote: split,
 * into two numbers, both shown. A judge should be able to see at a glance that
 * the prototype has processed, say, 4,000 simulated readings and 120 measured
 * ones, and form their own view — rather than being shown "4,120 readings
 * processed" and having to ask.
 *
 * ── On "response time" ────────────────────────────────────────────────────
 *
 * The one metric here with a genuinely misleading name, so it is named
 * carefully. AVERIS can measure the interval from a reading being received to
 * an alert row existing. That is *machine latency*, and it is a real engineering
 * result worth reporting.
 *
 * It is **not** clinical response time, which is the interval from a patient
 * deteriorating to a clinician arriving. AVERIS cannot measure that and never
 * will without a deployment. Presenting machine latency under the label
 * "response time" is how a truthful number becomes a false claim, so the field
 * is called `detectionLatency` and the label on screen says what it measured.
 */

export type Provenance = "measured" | "simulated";

/** One row as it comes out of the database, narrowed to what is needed. */
export type ReadingRow = {
  isSimulated: boolean;
  patientId: string;
  recordedAt: string;
  receivedAt: string | null;
};

export type AlertRow = {
  severity: "INFO" | "WARNING" | "CRITICAL";
  isSimulated: boolean;
  createdAt: string;
  /** When the reading that caused it arrived, when it can be traced. */
  triggeredByReceivedAt?: string | null;
  acknowledgedAt?: string | null;
};

export type EmergencyRow = {
  isSimulated: boolean;
  createdAt: string;
  acknowledgedAt: string | null;
  status: string;
};

/** A count split by where the data came from. Never a single total. */
export type SplitCount = {
  measured: number;
  simulated: number;
};

export type LatencySummary = {
  n: number;
  /**
   * Milliseconds from a reading being received to its alert existing.
   *
   * Median and p95, not mean. A mean latency is compatible with one alert in
   * twenty taking a minute, and for an alerting system the tail is the whole
   * question.
   */
  medianMs: number | null;
  p95Ms: number | null;
  /** Null when nothing could be traced — never zero, which reads as instant. */
  unavailableReason: string | null;
};

export type ImpactMetrics = {
  /**
   * Accounts that have produced at least one reading.
   *
   * Not "patients monitored", which in a prototype means the development team
   * and is a phrase that invites a reader to imagine a ward.
   */
  accountsWithReadings: SplitCount;
  readings: SplitCount;
  alerts: SplitCount;
  criticalAlerts: SplitCount;
  emergencies: SplitCount;
  /** Emergencies a human actually acknowledged in this deployment. */
  emergenciesAcknowledged: number;
  detectionLatency: LatencySummary;
  /** Days between the first and most recent reading. */
  daysOfData: number;
  /**
   * True when the deployment has never received a measured reading.
   *
   * The single most important field. When it is true, every "measured" column
   * is zero and the panel must say so in words rather than showing zeroes that
   * read as a rendering bug.
   */
  noMeasuredData: boolean;
};

export function emptyMetrics(): ImpactMetrics {
  return {
    accountsWithReadings: { measured: 0, simulated: 0 },
    readings: { measured: 0, simulated: 0 },
    alerts: { measured: 0, simulated: 0 },
    criticalAlerts: { measured: 0, simulated: 0 },
    emergencies: { measured: 0, simulated: 0 },
    emergenciesAcknowledged: 0,
    detectionLatency: {
      n: 0,
      medianMs: null,
      p95Ms: null,
      unavailableReason: "No alerts have been raised in this deployment.",
    },
    daysOfData: 0,
    noMeasuredData: true,
  };
}

function split(rows: { isSimulated: boolean }[]): SplitCount {
  let measured = 0;
  let simulated = 0;
  for (const row of rows) {
    if (row.isSimulated) simulated += 1;
    else measured += 1;
  }
  return { measured, simulated };
}

function percentile(sorted: number[], p: number): number {
  // Nearest-rank. With a handful of samples an interpolated p95 invents a
  // number between two observations; the rank is an observation that happened.
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * sorted.length) - 1));
  return sorted[index];
}

/**
 * Time from a reading arriving to its alert existing.
 *
 * Only alerts whose triggering reading can be identified contribute. An alert
 * with no traceable cause is excluded and *counted* in `n` versus the total —
 * silently dropping the untraceable ones would report the latency of the subset
 * that happened to be easy to measure.
 */
export function detectionLatency(alerts: AlertRow[]): LatencySummary {
  if (alerts.length === 0) {
    return {
      n: 0,
      medianMs: null,
      p95Ms: null,
      unavailableReason: "No alerts have been raised in this deployment.",
    };
  }

  const deltas: number[] = [];

  for (const alert of alerts) {
    if (!alert.triggeredByReceivedAt) continue;

    const received = Date.parse(alert.triggeredByReceivedAt);
    const raised = Date.parse(alert.createdAt);
    if (!Number.isFinite(received) || !Number.isFinite(raised)) continue;

    const delta = raised - received;
    // A negative interval means an alert exists before the reading that caused
    // it, which is a clock problem, not a fast system. Excluded rather than
    // clamped to zero — clamping would report an impossible result as an
    // excellent one.
    if (delta < 0) continue;

    deltas.push(delta);
  }

  if (deltas.length === 0) {
    return {
      n: 0,
      medianMs: null,
      p95Ms: null,
      unavailableReason:
        alerts.length === 1
          ? "1 alert exists, but it could not be traced back to the reading that caused it, so detection latency cannot be measured."
          : `${alerts.length} alerts exist, but none could be traced back to the readings that ` +
            `caused them, so detection latency cannot be measured.`,
    };
  }

  deltas.sort((a, b) => a - b);

  return {
    n: deltas.length,
    medianMs: percentile(deltas, 50),
    p95Ms: percentile(deltas, 95),
    unavailableReason:
      deltas.length < alerts.length
        ? `${alerts.length - deltas.length} of ${alerts.length} alerts could not be traced to a reading and are excluded.`
        : null,
  };
}

export function computeImpact(
  readings: ReadingRow[],
  alerts: AlertRow[],
  emergencies: EmergencyRow[],
): ImpactMetrics {
  const measuredPatients = new Set<string>();
  const simulatedPatients = new Set<string>();

  let earliest = Number.POSITIVE_INFINITY;
  let latest = Number.NEGATIVE_INFINITY;

  for (const reading of readings) {
    (reading.isSimulated ? simulatedPatients : measuredPatients).add(reading.patientId);

    const at = Date.parse(reading.recordedAt);
    if (Number.isFinite(at)) {
      earliest = Math.min(earliest, at);
      latest = Math.max(latest, at);
    }
  }

  const daysOfData =
    Number.isFinite(earliest) && Number.isFinite(latest) && latest > earliest
      ? Math.max(1, Math.round((latest - earliest) / 86_400_000))
      : readings.length > 0
        ? 1
        : 0;

  const readingSplit = split(readings);

  return {
    accountsWithReadings: {
      measured: measuredPatients.size,
      simulated: simulatedPatients.size,
    },
    readings: readingSplit,
    alerts: split(alerts),
    criticalAlerts: split(alerts.filter((a) => a.severity === "CRITICAL")),
    emergencies: split(emergencies),
    emergenciesAcknowledged: emergencies.filter((e) => e.acknowledgedAt !== null).length,
    detectionLatency: detectionLatency(alerts),
    daysOfData,
    noMeasuredData: readingSplit.measured === 0,
  };
}

/**
 * The sentence that goes at the top of the panel.
 *
 * Generated rather than hard-coded, because it has to be *true of this
 * deployment* — a fixed caption saying "prototype metrics" above a panel that
 * happens to contain real patient data would be as wrong as the reverse.
 */
export function provenanceCaption(metrics: ImpactMetrics): string {
  if (metrics.noMeasuredData && metrics.readings.simulated === 0) {
    return "This deployment has processed no readings yet. Every figure below is zero because nothing has happened, not because nothing was recorded.";
  }

  if (metrics.noMeasuredData) {
    return (
      `Every figure below comes from simulated readings. No physical device has reported to this ` +
      `deployment, so nothing here describes a real patient or a real health outcome.`
    );
  }

  return (
    `Figures are split by provenance. The measured column comes from physical devices; the ` +
    `simulated column comes from the demonstration path. Neither describes a health outcome — ` +
    `AVERIS has no outcome data and makes no claim about one.`
  );
}

/**
 * What this panel is not, in one place, for the screen.
 *
 * Exported as a constant so the wording cannot drift between the page, the
 * documentation and the pitch deck.
 */
export const IMPACT_DISCLAIMER =
  "These are prototype operating metrics: what this deployment has processed. They are not " +
  "clinical outcomes, not a trial result, and not evidence that AVERIS improves anyone's health. " +
  "Detection latency measures reading-to-alert inside the system, not how long a clinician took " +
  "to arrive — AVERIS cannot measure that without a real deployment.";
