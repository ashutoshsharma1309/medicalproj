/**
 * Patient summary — assembly, narration and the guardrail between them.
 *
 * **The split this file exists to enforce: the numbers are computed here, and
 * the model only phrases them.** Everything in `ReportSections` is arithmetic
 * over stored readings. A language model asked to work out whether oxygen
 * saturation fell over 24 hours can produce a confident direction from nothing;
 * asked to write a sentence about a decline it was handed, it cannot invent
 * one. Same rule as the digital twin's summary and the Phase 3 insight engine.
 *
 * Pure, so every number a clinician reads is reproducible from fixtures
 * without a database or a model.
 */

export type ReportChannel = "heartRate" | "spo2" | "temperature";

export type ChannelSummary = {
  min: number;
  max: number;
  mean: number;
  count: number;
  /**
   * Change across the window: the mean of the last fifth minus the mean of the
   * first fifth.
   *
   * Not last-minus-first. Two readings taken during a cough and during sleep
   * would produce a dramatic "trend" from noise; fifths average that out while
   * still being simple enough that a clinician can check the claim.
   */
  drift: number;
};

export type ReportSections = {
  periodStart: string;
  periodEnd: string;
  vitals: Partial<Record<ReportChannel, ChannelSummary>>;
  /** Readings actually stored in the window. */
  readingCount: number;
  /**
   * Longest silence in the window, in minutes. A report over a window the
   * device slept through is a report about nothing, and the reader has to be
   * able to see that.
   */
  longestGapMinutes: number | null;
  risk: {
    score: number;
    level: string;
    confidence: number | null;
    reasons: string[];
    assessedAt: string;
  } | null;
  alerts: { critical: number; warning: number; info: number };
  emergencies: {
    eventType: string;
    severity: string;
    status: string;
    summary: string;
    createdAt: string;
  }[];
};

export type ReadingRow = {
  heart_rate: number | null;
  spo2: number | null;
  temperature: number | null;
  recorded_at: string;
};

export type AlertRow = { severity: string };

export type EmergencyRow = {
  event_type: string;
  severity: string;
  status: string;
  summary: string;
  created_at: string;
};

export type PredictionRow = {
  risk_score: number | string;
  risk_category: string;
  confidence_score: number | string | null;
  explanation: unknown;
  created_at: string;
};

const CHANNEL_LABEL: Record<ReportChannel, string> = {
  heartRate: "Heart rate",
  spo2: "Blood oxygen",
  temperature: "Temperature",
};

const CHANNEL_UNIT: Record<ReportChannel, string> = {
  heartRate: " BPM",
  spo2: "%",
  temperature: "°C",
};

const CHANNEL_PRECISION: Record<ReportChannel, number> = {
  heartRate: 0,
  spo2: 0,
  temperature: 1,
};

export function assembleReport(input: {
  periodStart: string;
  periodEnd: string;
  readings: ReadingRow[];
  alerts: AlertRow[];
  emergencies: EmergencyRow[];
  prediction: PredictionRow | null;
}): ReportSections {
  // Oldest first, so drift means what it says regardless of how the caller
  // ordered its query.
  const ordered = [...input.readings].sort(
    (a, b) => Date.parse(a.recorded_at) - Date.parse(b.recorded_at),
  );

  const vitals: Partial<Record<ReportChannel, ChannelSummary>> = {};
  for (const channel of ["heartRate", "spo2", "temperature"] as ReportChannel[]) {
    const summary = summariseChannel(ordered, channel);
    if (summary) vitals[channel] = summary;
  }

  const alerts = { critical: 0, warning: 0, info: 0 };
  for (const alert of input.alerts) {
    if (alert.severity === "CRITICAL") alerts.critical += 1;
    else if (alert.severity === "WARNING") alerts.warning += 1;
    else alerts.info += 1;
  }

  return {
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    vitals,
    readingCount: ordered.length,
    longestGapMinutes: longestGap(ordered),
    risk: input.prediction ? riskFrom(input.prediction) : null,
    alerts,
    emergencies: input.emergencies.map((e) => ({
      eventType: e.event_type,
      severity: e.severity,
      status: e.status,
      summary: e.summary,
      createdAt: e.created_at,
    })),
  };
}

function summariseChannel(rows: ReadingRow[], channel: ReportChannel): ChannelSummary | null {
  const key =
    channel === "heartRate" ? "heart_rate" : channel === "spo2" ? "spo2" : "temperature";

  const values = rows
    .map((row) => row[key as keyof ReadingRow] as number | null)
    .filter((v): v is number => typeof v === "number");

  if (values.length === 0) return null;

  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;

  return {
    min: Math.min(...values),
    max: Math.max(...values),
    mean,
    count: values.length,
    drift: driftOf(values),
  };
}

/**
 * Change from the first fifth to the last fifth.
 *
 * Zero when there is too little data to say anything — a two-reading "trend"
 * is a line through two points, and reporting it as a direction is a claim the
 * data cannot support.
 */
function driftOf(values: number[]): number {
  if (values.length < 10) return 0;

  const size = Math.max(1, Math.floor(values.length / 5));
  const head = values.slice(0, size);
  const tail = values.slice(-size);

  const average = (list: number[]) => list.reduce((sum, v) => sum + v, 0) / list.length;
  return average(tail) - average(head);
}

function longestGap(rows: ReadingRow[]): number | null {
  if (rows.length < 2) return null;

  let worst = 0;
  for (let i = 1; i < rows.length; i += 1) {
    const gap = Date.parse(rows[i].recorded_at) - Date.parse(rows[i - 1].recorded_at);
    if (Number.isFinite(gap) && gap > worst) worst = gap;
  }

  return Math.round(worst / 60000);
}

function riskFrom(prediction: PredictionRow): ReportSections["risk"] {
  const explanation = (prediction.explanation ?? {}) as { explanation?: unknown };
  const reasons = Array.isArray(explanation.explanation)
    ? explanation.explanation.filter((r): r is string => typeof r === "string")
    : [];

  return {
    score: Number(prediction.risk_score),
    level: prediction.risk_category,
    confidence:
      prediction.confidence_score === null ? null : Number(prediction.confidence_score),
    reasons: reasons.slice(0, 5),
    assessedAt: prediction.created_at,
  };
}

/**
 * The fact sheet handed to the model.
 *
 * Deliberately flat text rather than JSON: a model handed a JSON object tends
 * to describe the object ("the spo2 field shows…"), and a clinician wants
 * prose about a patient.
 */
export function describeReport(sections: ReportSections): string {
  const lines: string[] = [];

  lines.push(`Monitoring window: ${sections.periodStart} to ${sections.periodEnd}`);
  lines.push(`Readings stored in the window: ${sections.readingCount}`);
  if (sections.longestGapMinutes !== null && sections.longestGapMinutes >= 15) {
    lines.push(
      `Longest interruption in monitoring: ${sections.longestGapMinutes} minutes with no readings`,
    );
  }

  for (const [channel, summary] of Object.entries(sections.vitals) as [
    ReportChannel,
    ChannelSummary,
  ][]) {
    const precision = CHANNEL_PRECISION[channel];
    const unit = CHANNEL_UNIT[channel];
    lines.push(
      `${CHANNEL_LABEL[channel]}: mean ${summary.mean.toFixed(precision)}${unit}, ` +
        `range ${summary.min.toFixed(precision)}–${summary.max.toFixed(precision)}${unit}, ` +
        `${describeDrift(channel, summary.drift)} (${summary.count} measurements)`,
    );
  }

  if (sections.risk) {
    lines.push(
      `AVERIS risk assessment: ${Math.round(sections.risk.score * 100)}% (${sections.risk.level}), ` +
        `confidence ${sections.risk.confidence === null ? "not recorded" : Math.round(sections.risk.confidence * 100) + "%"}`,
    );
    for (const reason of sections.risk.reasons) lines.push(`  - ${reason}`);
  } else {
    lines.push("AVERIS risk assessment: none recorded for this window");
  }

  lines.push(
    `Threshold alerts: ${sections.alerts.critical} critical, ` +
      `${sections.alerts.warning} warning, ${sections.alerts.info} informational`,
  );

  if (sections.emergencies.length > 0) {
    lines.push("Emergency events:");
    for (const event of sections.emergencies) {
      lines.push(`  - ${event.createdAt} ${event.eventType} (${event.status}): ${event.summary}`);
    }
  } else {
    lines.push("Emergency events: none in this window");
  }

  return lines.join("\n");
}

function describeDrift(channel: ReportChannel, drift: number): string {
  const precision = CHANNEL_PRECISION[channel];
  const unit = CHANNEL_UNIT[channel];

  // Thresholds below which the change is not distinguishable from sensor
  // noise, so the report says "steady" rather than reporting a direction the
  // measurement cannot support.
  const floor = channel === "heartRate" ? 2 : channel === "spo2" ? 1 : 0.2;

  if (Math.abs(drift) < floor) return "steady across the window";

  return `${drift > 0 ? "rose" : "fell"} by ${Math.abs(drift).toFixed(precision)}${unit} across the window`;
}

/**
 * Narration without a model.
 *
 * Used when no key is configured, when the call fails, and when the guardrail
 * rejects what came back. It restates the same assembled facts — so a report
 * is never empty, never invented, and never silently thinner than it looks.
 */
export function deterministicNarrative(sections: ReportSections): string {
  const parts: string[] = [];

  if (sections.readingCount === 0) {
    return (
      "No readings were stored for this patient during the window. " +
      "AVERIS has nothing to summarise, which usually means the device was not worn or not connected."
    );
  }

  parts.push(
    `AVERIS stored ${sections.readingCount} readings for this patient between ${sections.periodStart} and ${sections.periodEnd}.`,
  );

  for (const [channel, summary] of Object.entries(sections.vitals) as [
    ReportChannel,
    ChannelSummary,
  ][]) {
    const precision = CHANNEL_PRECISION[channel];
    const unit = CHANNEL_UNIT[channel];
    parts.push(
      `${CHANNEL_LABEL[channel]} averaged ${summary.mean.toFixed(precision)}${unit} ` +
        `(range ${summary.min.toFixed(precision)}–${summary.max.toFixed(precision)}${unit}) and ` +
        `${describeDrift(channel, summary.drift)}.`,
    );
  }

  if (sections.longestGapMinutes !== null && sections.longestGapMinutes >= 15) {
    parts.push(
      `Monitoring was interrupted for up to ${sections.longestGapMinutes} minutes during the window.`,
    );
  }

  if (sections.risk) {
    parts.push(
      `The most recent AVERIS risk assessment was ${Math.round(sections.risk.score * 100)}% (${sections.risk.level}).`,
    );
    if (sections.risk.reasons.length > 0) {
      parts.push(`It cited: ${sections.risk.reasons.join("; ")}.`);
    }
  }

  const { critical, warning } = sections.alerts;
  if (critical + warning > 0) {
    parts.push(
      `${critical} critical and ${warning} warning threshold alerts were raised in the window.`,
    );
  } else {
    parts.push("No critical or warning threshold alerts were raised in the window.");
  }

  if (sections.emergencies.length > 0) {
    parts.push(
      `${sections.emergencies.length} emergency ${
        sections.emergencies.length === 1 ? "event" : "events"
      }: ${sections.emergencies.map((e) => e.eventType.toLowerCase().replace(/_/g, " ")).join(", ")}.`,
    );
  }

  parts.push(REPORT_FOOTER);
  return parts.join(" ");
}

export const REPORT_FOOTER =
  "This summary restates measurements and the thresholds they crossed. It is not a diagnosis and not a treatment recommendation.";

/**
 * Language a monitoring summary must not contain.
 *
 * Narrower than the patient-facing document guardrail, and differently aimed.
 * The reader here *is* a clinician, so "discuss with your healthcare provider"
 * would be nonsense — what must not appear is AVERIS reaching a conclusion or
 * proposing a course of action, because a monitoring platform that recommends
 * treatment has quietly become a medical device.
 */
const CLINICAL_JUDGEMENT = [
  // A diagnosis, however hedged.
  /\bdiagnos(?:is|e|ed|tic)\b/i,
  // "Consistent with" is only judgement when it names a pathology. AVERIS's
  // own alert text says "a movement pattern consistent with a fall", and a
  // guardrail that rejected the platform's own wording would replace every
  // report about a fall.
  /\bconsistent with\s+(?:\w+\s+){0,3}(?:sepsis|pneumonia|infection|arrhythmia|ischaemia|ischemia|embolism|failure|syndrome)\b/i,
  /\b(?:likely|probable|suggestive of|indicative of|points to)\s+(?:sepsis|pneumonia|infection|failure|arrhythmia|deterioration|hypoxia)\b/i,
  // Prescribing or recommending an intervention.
  /\b(?:prescrib|administer|titrat|initiate)\w*\b/i,
  /\b(?:should|must|needs? to)\s+(?:be\s+)?(?:start|stop|increase|decrease|admit|escalate|transfer|treat)\w*\b/i,
  /\brecommend(?:s|ed|ation)?\b/i,
  /\b(?:oxygen therapy|antibiotics|fluid resuscitation|ventilation)\b/i,
  // A prognosis.
  /\b(?:prognosis|life expectancy|will (?:deteriorate|recover|improve))\b/i,
];

export function enforceNoClinicalJudgement(
  narrative: string,
  sections: ReportSections,
): { summary: string; rewritten: boolean } {
  if (CLINICAL_JUDGEMENT.some((pattern) => pattern.test(narrative))) {
    // Replaced with the deterministic narration rather than a stub. A clinician
    // who asked for a summary and received an apology got nothing; the
    // assembled facts are still exactly as true as they were.
    return { summary: deterministicNarrative(sections), rewritten: true };
  }

  const closed = narrative.includes(REPORT_FOOTER)
    ? narrative
    : `${narrative.trim()} ${REPORT_FOOTER}`;

  return { summary: closed, rewritten: false };
}
