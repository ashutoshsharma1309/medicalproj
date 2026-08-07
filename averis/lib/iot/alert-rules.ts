import type { SensorReadingInput } from "./reading-validation";

/**
 * Threshold alerting.
 *
 * Deliberately rules, not a model. An alert is a claim that something about a
 * person needs attention, and a patient who is told that deserves to know
 * exactly what tripped it. "Your SpO2 was 88% and the threshold is 90%" is
 * checkable; "the model flagged this" is not, and at 3am it is worse than
 * silence.
 *
 * The same reasoning as the Phase 3 insight engine and the Phase 4 risk
 * models: rules decide, and anything generative only ever phrases.
 *
 * **These are not diagnoses.** Every threshold below is a widely published
 * escalation trigger, not a clinical judgement, and the message says what was
 * measured rather than what it means.
 */

export type AlertType =
  | "HEART_RATE_HIGH"
  | "HEART_RATE_LOW"
  | "SPO2_LOW"
  | "TEMPERATURE_HIGH"
  | "TEMPERATURE_LOW"
  | "FALL_SUSPECTED"
  | "DEVICE_OFFLINE"
  | "BATTERY_LOW";

export type AlertSeverity = "INFO" | "WARNING" | "CRITICAL";

export type RaisedAlert = {
  alertType: AlertType;
  severity: AlertSeverity;
  message: string;
  observedValue: number | null;
  thresholdValue: number | null;
};

/**
 * Thresholds for a resting adult.
 *
 * Age, fitness and pregnancy all move these, and a real deployment would
 * personalise them from the patient's profile. They are constants here because
 * inventing per-patient thresholds without clinical input would be worse than
 * using published ones and saying so.
 */
export const THRESHOLDS = {
  heartRate: { criticalLow: 40, low: 50, high: 120, criticalHigh: 150 },
  // 90% is the widely used escalation point; 94% is a common early warning.
  spo2: { critical: 90, warning: 94 },
  temperature: { criticalLow: 35.0, low: 35.5, high: 38.0, criticalHigh: 39.5 },
  battery: { low: 15 },
} as const;

export function evaluateReading(reading: SensorReadingInput): RaisedAlert[] {
  const alerts: RaisedAlert[] = [];

  /* ------------------------------------------------------------ SpO2 */
  // Checked first because low oxygen saturation is the fastest-moving of these.
  if (reading.spo2 !== null) {
    if (reading.spo2 < THRESHOLDS.spo2.critical) {
      alerts.push({
        alertType: "SPO2_LOW",
        severity: "CRITICAL",
        message: `Blood oxygen measured ${reading.spo2}%, below the ${THRESHOLDS.spo2.critical}% escalation threshold.`,
        observedValue: reading.spo2,
        thresholdValue: THRESHOLDS.spo2.critical,
      });
    } else if (reading.spo2 < THRESHOLDS.spo2.warning) {
      alerts.push({
        alertType: "SPO2_LOW",
        severity: "WARNING",
        message: `Blood oxygen measured ${reading.spo2}%, below the usual ${THRESHOLDS.spo2.warning}% range.`,
        observedValue: reading.spo2,
        thresholdValue: THRESHOLDS.spo2.warning,
      });
    }
  }

  /* ------------------------------------------------------ heart rate */
  if (reading.heartRate !== null) {
    const hr = reading.heartRate;

    if (hr >= THRESHOLDS.heartRate.criticalHigh) {
      alerts.push(hrAlert("HEART_RATE_HIGH", "CRITICAL", hr, THRESHOLDS.heartRate.criticalHigh, "above"));
    } else if (hr > THRESHOLDS.heartRate.high) {
      alerts.push(hrAlert("HEART_RATE_HIGH", "WARNING", hr, THRESHOLDS.heartRate.high, "above"));
    } else if (hr <= THRESHOLDS.heartRate.criticalLow) {
      alerts.push(hrAlert("HEART_RATE_LOW", "CRITICAL", hr, THRESHOLDS.heartRate.criticalLow, "below"));
    } else if (hr < THRESHOLDS.heartRate.low) {
      alerts.push(hrAlert("HEART_RATE_LOW", "WARNING", hr, THRESHOLDS.heartRate.low, "below"));
    }
  }

  /* ----------------------------------------------------- temperature */
  if (reading.temperature !== null) {
    const t = reading.temperature;

    if (t >= THRESHOLDS.temperature.criticalHigh) {
      alerts.push(tempAlert("TEMPERATURE_HIGH", "CRITICAL", t, THRESHOLDS.temperature.criticalHigh));
    } else if (t > THRESHOLDS.temperature.high) {
      alerts.push(tempAlert("TEMPERATURE_HIGH", "WARNING", t, THRESHOLDS.temperature.high));
    } else if (t <= THRESHOLDS.temperature.criticalLow) {
      alerts.push(tempAlert("TEMPERATURE_LOW", "CRITICAL", t, THRESHOLDS.temperature.criticalLow));
    } else if (t < THRESHOLDS.temperature.low) {
      alerts.push(tempAlert("TEMPERATURE_LOW", "WARNING", t, THRESHOLDS.temperature.low));
    }
  }

  /* ------------------------------------------------------------ fall */
  if (reading.movementStatus === "FALL_SUSPECTED") {
    alerts.push({
      alertType: "FALL_SUSPECTED",
      severity: "CRITICAL",
      message: "The device reported a movement pattern consistent with a fall.",
      observedValue: null,
      thresholdValue: null,
    });
  }

  /* --------------------------------------------------------- battery */
  if (reading.batteryPercentage !== null && reading.batteryPercentage <= THRESHOLDS.battery.low) {
    alerts.push({
      alertType: "BATTERY_LOW",
      // INFO, not WARNING: a flat battery is an inconvenience, and ranking it
      // alongside a vital sign teaches people to ignore the colour.
      severity: "INFO",
      message: `Device battery is at ${reading.batteryPercentage}%.`,
      observedValue: reading.batteryPercentage,
      thresholdValue: THRESHOLDS.battery.low,
    });
  }

  return alerts;
}

/**
 * Whether an alert should be raised given what is already open.
 *
 * A device at 0.5 Hz that stays below threshold for ten minutes would generate
 * 300 identical alerts. The result is not 300 times the safety — it is a list
 * nobody reads, which is strictly less safe than one alert that stays visible.
 *
 * So the same type stays suppressed while it is still ACTIVE, unless the
 * severity has escalated: WARNING → CRITICAL is genuinely new information and
 * must get through.
 */
export function shouldRaise(
  candidate: RaisedAlert,
  openAlerts: { alertType: AlertType; severity: AlertSeverity }[],
): boolean {
  const existing = openAlerts.find((a) => a.alertType === candidate.alertType);
  if (!existing) return true;

  return severityRank(candidate.severity) > severityRank(existing.severity);
}

export function severityRank(severity: AlertSeverity): number {
  return { INFO: 1, WARNING: 2, CRITICAL: 3 }[severity];
}

/** The most serious alert in a set, for the dashboard's overall state. */
export function highestSeverity(alerts: RaisedAlert[]): AlertSeverity | null {
  if (alerts.length === 0) return null;
  return alerts.reduce((worst, a) =>
    severityRank(a.severity) > severityRank(worst.severity) ? a : worst,
  ).severity;
}

function hrAlert(
  alertType: AlertType,
  severity: AlertSeverity,
  observed: number,
  threshold: number,
  direction: "above" | "below",
): RaisedAlert {
  return {
    alertType,
    severity,
    message: `Heart rate measured ${observed} BPM, ${direction} the ${threshold} BPM threshold.`,
    observedValue: observed,
    thresholdValue: threshold,
  };
}

function tempAlert(
  alertType: AlertType,
  severity: AlertSeverity,
  observed: number,
  threshold: number,
): RaisedAlert {
  const direction = alertType === "TEMPERATURE_HIGH" ? "above" : "below";
  return {
    alertType,
    severity,
    message: `Body temperature measured ${observed}°C, ${direction} the ${threshold}°C threshold.`,
    observedValue: observed,
    thresholdValue: threshold,
  };
}
